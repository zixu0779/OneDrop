# OneDrop architecture

## 1. Product boundary

OneDrop is a Microsoft Edge-only browser extension. It shares text and files between Edge installations belonging to the same Microsoft account by storing data in that user's OneDrive.

The system has:

- no backend server;
- no SaaS control plane or application database;
- no server-side message queue;
- no content scripts or access to arbitrary websites;
- no automatic delivery of messages created while offline.

OneDrive is the cloud persistence layer and the source of truth. Local browser storage is an index and cache that can be rebuilt.

## 2. Runtime architecture

### Side Panel

The Edge Side Panel is the primary product surface. It will render the timeline, compose text messages, select files, show transfer progress, and expose sign-in and cache controls.

The Side Panel never calls Microsoft Graph directly. It sends typed runtime commands to the service worker and renders returned state. This keeps tokens and privileged network behavior out of presentation code.

### MV3 service worker

The service worker owns authentication, Graph requests, synchronization, ETag retries, transfer orchestration, and scheduled cache maintenance.

Manifest V3 workers are ephemeral. No operation may depend on an in-memory singleton surviving between events. Recoverable state belongs in IndexedDB or `browser.storage`; active UI state can remain in the Side Panel.

### Local persistence

- IndexedDB stores the local message index, known monthly document ETags, and cache metadata.
- Cache Storage stores managed preview/download responses.
- `browser.storage.local` stores small preferences and durable authentication material when authentication is implemented.
- `browser.storage.session` may hold short-lived access state.

The first release will not request `unlimitedStorage`. Cache behavior must operate within an explicit application limit.

## 3. Cloud layout

OneDrop uses the least-privilege OneDrive App Folder reached through `/me/drive/special/approot`.

```text
Apps/OneDrop/
├── schema.json
├── messages/
│   └── 2026-08/
│       ├── 0001.json
│       └── 0002.json
├── archive/
│   ├── 2026-07.json
│   └── 2026-06.json
├── files/
│   └── 2026/
│       └── 08/
│           └── <message-id>/
│               └── <original-file-name>
└── tombstones/
    ├── 2026-08.json
    └── 2026-07.json
```

The physical OneDrive App Folder name is determined by the Microsoft Entra application registration.

The chunked layout above is the only supported message layout. Obsolete `messages/YYYY-MM.json` files are not probed, read, migrated, or deleted by OneDrop.

## 4. Monthly message documents

Each UTC month maps to an ordered set of metadata chunks. The current month's active chunk is mutable; prior chunks and prior months are logically immutable.

```json
{
  "schemaVersion": 1,
  "month": "2026-08",
  "messages": []
}
```

Attachments are stored as independent OneDrive files. Monthly JSON documents contain metadata and DriveItem references, never embedded file bytes.

### Month selection

The successful commit time determines the partition. An attachment is uploaded first. Immediately before the message metadata is committed, OneDrop selects the current UTC month. A manually retried send is a new current-time attempt and is not backdated into a closed month.

At a month boundary, the first successful message in the new month creates `messages/<new month>/0001.json`. The preceding month's chunk directory becomes eligible for archive compaction after the grace period.

### Concurrency protocol

OneDrive does not provide an atomic JSON append. Concurrent writers therefore use compare-and-swap semantics:

1. Read the current month document and its ETag.
2. Merge the new message by globally unique message ID.
3. Write with `If-Match` using the observed ETag.
4. On `412 Precondition Failed`, read the newer document, merge, deduplicate, and retry with bounded exponential backoff.
5. Stop after the retry budget and present a failed send.

Blind overwrite is forbidden. Within one extension installation, write commands are additionally serialized to reduce self-conflicts.

### Growth and archival

The current schema uses deterministic active-month chunks with a 256 KiB soft target and 320 KiB hard ceiling. This keeps ordinary conditional rewrites small while avoiding a mutable shared pointer file. Chunk discovery follows Microsoft Graph pagination rather than assuming all children fit in one response.

Once a month is closed for 24 hours, its chunks may be compacted into one immutable `archive/YYYY-MM.json`. The archive is created with conflict behavior `fail`, verified before publication is considered complete, and does not require immediate deletion of its source chunks. Late offline sends are not supported, so normal send behavior never reopens archived months.

## 5. Send semantics

OneDrop intentionally has no offline outbox or delayed delivery queue.

- A send is successful only after its attachment, if any, and monthly metadata are committed to OneDrive.
- A connection loss or exhausted retry budget produces a visible failed state.
- Failed sends are not automatically transmitted when connectivity returns.
- A user-triggered retry starts a new attempt and uses the successful retry time.
- The UI may retain failed draft data locally for user convenience, but it is not a delivery queue.

OneDrive is file storage, not a message broker. It offers no FIFO consumption, acknowledgement, visibility timeout, dead-letter queue, or consumer leasing, and OneDrop will not emulate those facilities.

### Deletion scope

The product supports deletion of individual messages only. It does not expose a delete-month operation. A message deletion will be represented by a versioned tombstone containing the message ID, original month, and deletion timestamp. Readers apply tombstones to active chunks and archives consistently. Physical removal from metadata and attachment cleanup are maintenance concerns and must never make a deleted message visible again.

## 6. Synchronization

Without a public backend endpoint, OneDrop cannot depend on Microsoft Graph change-notification webhooks. Synchronization is pull-based:

- refresh when the Side Panel opens or regains focus;
- refresh after a successful local send;
- refresh on explicit user action;
- optionally perform low-frequency best-effort checks with `browser.alarms`.

Historical month documents are cached locally and fetched on demand as the user scrolls. ETags and `If-None-Match` avoid downloading unchanged documents.

There is no promise of real-time background delivery while Edge or the extension is inactive.

### Current read implementation

OneDrop enumerates `messages/<UTC YYYY-MM>/` with Graph pagination. A missing directory is a valid empty state. It reuses locally cached chunk content when the DriveItem ETag is unchanged, downloads changed chunks, validates `schemaVersion`, the month partition, and every message, then returns the deduplicated chronological result to the Side Panel. No remote response is allowed to enter application state before schema validation.

### Current text write implementation

Text messages are limited to 20,000 characters and assigned a UUID before the cloud transaction. Each Edge installation also persists an anonymous device UUID in extension-local storage and stamps new messages with `senderDeviceId`; this is used only to align local bubbles on the right and is not an account or tracking identifier. Older messages without this optional field remain readable and render as remote. OneDrop caches validated monthly snapshots and folder IDs in IndexedDB. After the first read, the normal send path merges locally and performs one conditional upload. A missing or full active chunk creates its deterministic successor with conflict behavior `fail`; an existing active chunk is replaced with its exact ETag in `If-Match`. HTTP 409 and 412 responses invalidate the cache and cause a bounded read-merge-retry cycle of at most five attempts. HTTP 429 and network failures are reported immediately and are never queued for later delivery. An ambiguous network failure also invalidates the snapshot so the next operation must reconcile with OneDrive.

## 7. File transfer

The implemented small-file transaction is:

1. Validate the selected file locally.
2. Upload the file into `files/YYYY/MM/<message-id>/`.
3. Obtain the resulting DriveItem metadata.
4. Commit the message into the current monthly JSON document with ETag protection.
5. If metadata commit fails, report failure and record the uploaded object for later orphan cleanup rather than silently claiming success.

Files up to 4 MiB use direct upload through the service worker. The Side Panel sends base64 file content over the extension runtime boundary; tokens remain outside presentation code. The UI keeps a local transfer bubble until both upload and metadata commit succeed. Upload failure offers Resend; metadata-only failure preserves the DriveItem and offers Retry without uploading again. If the original browser File is no longer readable, Resend opens the file picker for explicit reselection.

Larger files will use a Microsoft Graph upload session with bounded retries while the user operation remains active. Upload sessions are not resumed automatically in a later browser session.

## 8. Local downloads and optional preview cache

OneDrop distinguishes user-owned downloads from extension-managed transient data.

- Clicking a file or image opens an existing, still-accessible local download when one is known; otherwise OneDrop downloads it from OneDrive.
- The message menu offers Save as so the user can choose a location. When the downloads API exposes that saved item, OneDrop records its download ID and can recognize and open it later.
- Downloads use the browser's `uniquify` conflict behavior so a later file with the same name does not overwrite the existing file.
- User-downloaded files are user-owned and are never automatically deleted by OneDrop.
- IndexedDB stores only a download registry such as DriveItem ID, cloud ETag, browser download ID, resolved filename, existence state, and last-opened time. This registry may be pruned when entries no longer exist.
- A managed full-file byte cache is not required for the initial product because it would duplicate user downloads and require capacity, TTL, and eviction controls.
- Cache Storage may later be used for bounded image preview data only. Preview cache entries remain extension-owned and may be evicted automatically when their cloud ETag changes or under storage pressure.

## 9. Authentication and permissions

The intended authentication flow is Microsoft identity platform Authorization Code with PKCE for a public client. There is no client secret in the extension package.

Before product work begins, a focused technical spike must validate the production extension ID, `browser.identity.launchWebAuthFlow`, Microsoft Entra redirect URI registration, token exchange CORS behavior, personal accounts, work/school accounts, and sign-out cleanup.

The desired delegated Graph permission is `Files.ReadWrite.AppFolder`.

Initial extension permissions:

```text
alarms
identity
sidePanel
storage
```

Initial host permissions:

```text
https://graph.microsoft.com/*
https://login.microsoftonline.com/*
```

The project does not request `tabs`, `activeTab`, `scripting`, content-script access, or access to arbitrary sites. A future user-initiated save-to-Downloads feature may justify adding `downloads` separately.

## 10. Module boundaries

```text
entrypoints/       WXT browser entrypoints only
src/app/           React composition and providers
src/components/    reusable presentation components
src/features/      product use cases grouped by capability
src/background/    worker commands, events, and scheduling
src/domain/        browser-independent business models
src/contracts/     runtime and cloud boundary contracts
src/infrastructure Graph, OneDrive, IndexedDB, cache, browser adapters
src/config/        non-secret application constants
src/shared/        genuinely cross-cutting utilities
tests/             unit and integration tests
e2e/               packaged-extension browser tests
```

Domain and contract code must not depend on React, WXT, or Microsoft Graph response classes. Infrastructure maps external data into validated domain types.

## 11. Delivery sequence

1. Project foundation and architecture documentation.
2. Authentication and App Folder compatibility spike.
3. Read-only monthly document synchronization.
4. Text message conditional-write transaction.
5. File upload and attachment metadata.
6. File download/open behavior, Save as, and the local download registry.
7. Failure recovery, observability, accessibility, and Edge Add-ons packaging.

Each stage should preserve the no-backend and least-privilege boundaries.
