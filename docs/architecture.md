# OneDrop architecture

## Product boundary

OneDrop sends text and files between clients owned by the same user. It has no backend server, SaaS database, server-side queue, content scripts, or access to arbitrary websites.

OneDrive is the cloud source of truth. Local browser storage and IndexedDB hold rebuildable indexes, caches, transfer state, settings, and authentication material.

## Clients

- Desktop Edge: WXT, React, TypeScript, Manifest V3.
- Android Edge: WXT, React, TypeScript, Manifest V3, with a tab-based auth fallback.
- iOS: the shared React UI inside Capacitor with native auth and platform adapters.

The shared UI sends typed commands to the platform runtime. It does not call Microsoft Graph directly. Tokens and privileged network operations stay in the runtime layer.

Manifest V3 service workers are ephemeral, so recoverable state must be persisted in IndexedDB or `browser.storage`.

## Local persistence

- IndexedDB stores the message index, month ETags, transfer state, folder IDs, and download registry.
- Cache Storage is reserved for bounded extension-owned preview data.
- `browser.storage.local` stores small preferences and durable authentication tokens.
- `browser.storage.session` is still read only to migrate or clear token data written by earlier validation builds.

The extension does not request `unlimitedStorage`; managed local data must remain bounded or rebuildable.

## OneDrive layout

OneDrop stores its data in the explicit `/Apps/OneDrop` path through
`/me/drive/root:/Apps/OneDrop`. On first use it creates `Apps` and `OneDrop`
when they do not already exist.

```text
Apps/OneDrop/
├── schema.json
├── messages/
│   └── 2026-08/
│       ├── 0001.json
│       └── 0002.json
├── archive/
│   └── 2026-07.json
├── files/
│   └── 2026/
│       └── 08/
│           └── <message-id>/
│               └── <original-file-name>
└── tombstones/
    └── 2026-08.json
```

The supported live message layout is `messages/YYYY-MM/NNNN.json`; old flat
`messages/YYYY-MM.json` documents are not part of the current storage contract.

## Message storage

Each UTC month is stored as ordered JSON chunks. The current month's active chunk is mutable. Older chunks are read for history and may be archived or physically compacted after deleted-message retention expires.

```json
{
  "schemaVersion": 1,
  "month": "2026-08",
  "messages": []
}
```

Attachments are stored as separate OneDrive files. Message JSON stores metadata and DriveItem references, not file bytes.

The successful commit time selects the month. A user retry is a new send attempt and uses the time of that successful retry.

## Writes and conflicts

OneDrive does not provide atomic JSON append, so OneDrop uses ETag compare-and-swap:

1. Read the target chunk and ETag.
2. Merge by globally unique message ID.
3. Write with `If-Match`.
4. On `409` or `412`, invalidate the cache, read the newer data, merge, deduplicate, and retry with a bounded budget.
5. Report failure when the retry budget is exhausted.

Blind overwrite is forbidden. Writes from one installation are also serialized locally to reduce self-conflicts.

Text messages are limited to 20,000 characters and receive a UUID before the cloud transaction. Each installation also stores an anonymous local device UUID so the UI can align the user's own messages; it is not an account identifier.

## Archival

After a month is closed for 24 hours, synchronization may publish `archive/YYYY-MM.json` in the background. Publication uses conflict behavior `fail`, read-back verification, persisted retry state, and digest checks before source chunks are removed.

A month archive is a compact historical copy, not a different message model. Tombstones still apply to archived months, and later physical cleanup may conditionally rewrite the archive to remove expired deleted records.

## Synchronization

Synchronization is pull-based:

- when the UI opens or regains focus;
- after a successful local send;
- on explicit refresh;
- through low-frequency best-effort `browser.alarms`.

Readers enumerate `messages/<UTC YYYY-MM>/` with Graph pagination. Missing month directories are valid empty states. Cached chunks are reused when ETags match, and all remote JSON is schema-validated before it enters application state.

There is no real-time delivery guarantee while Edge or the extension is inactive.

## Deleted Data

User deletion removes a message from the visible timeline by writing a versioned tombstone with the message ID, original month, and deletion time. Readers apply tombstones to live chunks and archives, so the deleted message does not reappear during synchronization.

The recycle bin reads tombstones against the original unfiltered record. Restore removes only the matching tombstone after confirming the source message still exists.

Physical deletion is separate. After the retention period, or after a separately confirmed manual cleanup, OneDrop may remove the message metadata from source chunks and archives. For file messages it also verifies that no visible message still references the same DriveItem and that the file is inside the deterministic OneDrop attachment folder before deleting that folder.

Cleanup is best-effort and conditional. If source data changed, is damaged, still conflicts, or cannot be verified safely, the tombstone remains and cleanup is retried later. User-downloaded files are outside extension-managed cleanup and are never removed by OneDrop.

Purely local failed sends were never committed to OneDrive; confirming their removal deletes them from IndexedDB without a tombstone.

## File transfer

A file send uploads the attachment first, then commits message metadata with ETag protection. If metadata commit fails, OneDrop reports failure and records the uploaded object for later orphan cleanup.

Files up to 4 MiB use direct upload through the service worker. Larger files stay as Blobs in shared IndexedDB while the service worker uploads them through a Microsoft Graph upload session. The UI shows progress and supports cancellation.

User-opened and user-saved downloads are treated as user-owned files. OneDrop stores only a registry that helps reopen known downloads later.

## Authentication and permissions

Authentication uses Microsoft identity platform Authorization Code with PKCE. Setup details are in [authentication.md](authentication.md).

The delegated Graph permission is `Files.ReadWrite`. This is broader than the
preview App Folder permission but avoids relying on OneDrive's broken
`approot` recreation after the user deletes the `Apps` folder.

Desktop permissions:

```text
alarms, downloads, downloads.open, identity, sidePanel, storage
```

Android additionally uses `tabs` and host permissions for OneDrive download URLs:

```text
https://graph.microsoft.com/*
https://login.microsoftonline.com/*
https://*.files.1drv.com/*
https://*.sharepoint.com/*
```

The project does not use `activeTab`, `scripting`, content scripts, or arbitrary site access.

## Module boundaries

```text
apps/
  desktop-edge/       desktop WXT entrypoints and adapters
  android-edge/       Android Edge entrypoints and adapters
  ios/                Capacitor web entrypoint, Xcode project, Swift plugins

packages/
  core/               browser-independent domain types and contracts
  onedrive/           Microsoft Graph and OneDrive persistence
  web-storage/        IndexedDB and browser-owned persistent caches
  platform/           platform bridge contracts and shared browser adapter
  app-runtime/        auth, device, download, and settings services
  extension-runtime/  shared MV3 service-worker implementation
  ui/                 shared React application

tests/                unit and integration tests
e2e/                  packaged-extension browser tests
```

Each app is a composition root. Shared behavior belongs in `packages/`. `core` must not depend on React, DOM APIs, WXT, Capacitor, IndexedDB, or Microsoft Graph response classes.
