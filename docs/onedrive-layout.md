# OneDrive storage contract

Status: root checks, cached monthly reads, lazy historical-month loading, active-month chunk writes, one-time historical-month archives with safe source cleanup, file attachments, logical single-message deletion, and delayed deleted-data cleanup are implemented.

The root App Folder lookup, current-month read, text message write, small-file upload, and current-month tombstone paths are implemented.

## Root

OneDrop stores its data beneath the Microsoft Graph App Folder at `/me/drive/special/approot` using delegated `Files.ReadWrite.AppFolder` access.

The first successful lookup can create the application folder in OneDrive. The current validation UI displays the returned DriveItem name and ID and, when available, its OneDrive web URL. It does not create any children beneath that folder.

The `/special/approot` endpoint is the identity boundary for this lookup. The client validates the returned DriveItem ID and name but does not reject a successful response when an optional `specialFolder` facet is omitted. OneDrive may localize the visible name of its parent `Apps` special folder; clients must use the `approot` alias or DriveItem IDs rather than localized path text.

## Monthly records

`messages/YYYY-MM/NNNN.json` is the active metadata layout for a UTC month. Only the current month is mutable. A conditional ETag write is mandatory for every existing-chunk update.

The obsolete `messages/YYYY-MM.json` layout is outside the protocol: OneDrop does not probe, read, migrate, or delete those files. Historical documents are not rewritten by normal send behavior. OneDrop does not automatically replay failed or offline sends into historical months.

The reader enumerates a requested UTC month's chunk directory with Graph pagination. The Side Panel initially requests the current month, then requests one earlier month whenever the timeline reaches its top. Historical results are prepended while preserving the visible scroll position. HTTP 404 is interpreted as an empty month, not an error. Every chunk must expose an ETag and pass the versioned Zod schema. A malformed chunk is isolated so healthy chunks can still be displayed, while writes to that month remain blocked until the user repairs or deletes the damaged file from the pinned recovery notice.

The first text send creates the month folder and `0001.json`. Subsequent sends replace the active chunk only when its previously read ETag still matches. Once adding a message would exceed the 256 KiB soft target, the writer creates the deterministic successor instead. Every individual chunk has a 320 KiB hard ceiling. A validated snapshot and folder IDs are cached in IndexedDB. Old cache records that contain no chunk metadata are invalidated automatically. The normal subsequent-send path therefore performs one conditional upload. Create and update conflicts invalidate the snapshot, then re-read, merge by immutable message ID, and retry within a fixed budget.

A network failure after an upload starts is ambiguous: OneDrive might have accepted the request even though OneDrop did not receive the response. OneDrop invalidates the cached snapshot and reports failure; it does not automatically replay the message. The next read must reconcile with OneDrive first.

## Active-month chunks

The mutable current UTC month uses deterministic chunk files with a 256 KiB soft target and 320 KiB hard ceiling. No shared `current.json` pointer is used. Readers enumerate chunk children with Graph pagination. Writers derive the active chunk from validated metadata and create deterministic successors with conflict behavior `fail`.

After a month closes and a 24-hour grace period passes, the unified foreground synchronization entry point asks a separate background scheduler to inspect eligible source-month folders. At most one month is scheduled per sync. Historical scrolling only reads an existing archive or its source chunks and never starts or waits for publication.

The scheduler applies tombstones, publishes `archive/YYYY-MM.json` once with create-with-conflict-fail, and reads it back before recording success. A concurrently published byte-equivalent archive is accepted. A successful month is never archived again; later deletions remain tombstones during their grace period and may then be conditionally compacted from the existing archive. Transient failures use persisted retry delays of 5 minutes, 30 minutes, 6 hours, then 24 hours, checked during later synchronizations. Manual Retry bypasses only the delay and shares the same per-month in-flight task. Damaged or conflicting sources and unverifiable existing archives are blocked rather than overwritten.

The first later synchronization after a verified publication reads the raw archive again, compares its SHA-256 digest with the recorded publication, confirms tombstones can still be applied, and only then deletes `messages/YYYY-MM/`. Cleanup failure leaves the successful archive state intact and is retried during later synchronizations. Archive status never delays foreground synchronization or history loading. Failures are exposed through the existing non-blocking centered notification stack; an open failure card is updated in place for automatic or manual retry and success.

## Attachments

Attachment bytes live under `files/YYYY/MM/<message-id>/`. A message record refers to the returned DriveItem ID, original name, MIME type, and size.

New image records may additionally store the original pixel dimensions and a Base64-encoded ThumbHash. OneDrop generates the hash locally from a canvas no larger than 100 pixels on its longest edge. The hash is only a compact visual approximation used for a blurred placeholder while the original image is loading or unavailable; it is not a separate OneDrive file and cannot reconstruct the original image. Older records without these optional fields remain valid and use the generic placeholder.

## Deletion

Deletion is limited to individual messages. OneDrop does not offer deletion of an entire month. Versioned tombstones in `tombstones/YYYY-MM.json` identify the message ID, original month, and deletion timestamp. Existing tombstone documents are replaced with their exact ETag; create and update conflicts are re-read and retried within a five-attempt budget. Current-month, historical-chunk, and archive readers apply tombstones before returning messages or conflict notices. The foreground deletion transaction is logical: message chunks, archives, OneDrive attachments, and user-downloaded files are not removed before the message disappears.

Each new tombstone records the recovery policy that applied when the message was deleted. The account may disable recovery, retain items for 3, 7, 10, or 30 days, or retain them permanently. Legacy tombstones retain the original 10-day behavior. Disabling the recycle bin hides its UI entry and schedules immediate background physical cleanup; permanent items remain recoverable until manual cleanup. Changing the account setting affects later deletions only.

A foreground synchronization starts a separate best-effort maintenance request at most once per 24 hours, without blocking or disabling the message UI. The cleaner reads the raw archive and source chunks and rejects conflicting data. For file messages it verifies that no other visible message references the DriveItem, resolves only the deterministic `files/YYYY/MM/<message-id>` folder, confirms the expected DriveItem is a child, and deletes that OneDrop-owned folder; a missing folder is accepted. It then uses ETag-conditional writes to remove the message from the archive and any surviving source chunks, refreshes the stored archive digest, and conditionally removes the tombstone last. Text messages and `file-uploading` placeholders skip attachment lookup. The recycle bin resolves tombstones against unfiltered source records and restores an item through an ETag-conditional tombstone removal only while the source record still exists. Recycle-bin reads, restoration, and physical cleanup share one maintenance queue. Its manual cleanup action uses the same ordered cleaner but, after an irreversible-action confirmation, scans every tombstone immediately without the configured grace period or 24-hour throttle. Unsafe cases remain unprocessed automatically and surface as manual failures; transient failures leave the scan retryable with the tombstone intact. Purely local failed transfers are deleted immediately from IndexedDB after confirmation. User-downloaded files are never deleted.

## Settings

Account-wide policy is stored in `settings/account.json`; device presentation and interaction preferences are stored separately in `settings/devices/<device-id>.json`. Each client also caches its current documents locally so theme and text size can apply before the first remote read. OneDrive writes use ETag guards and bounded conflict retries. A reinstalled client receives a new device ID and may explicitly copy preferences from an existing device record. Resetting restores only the current device defaults. Theme, text size, message links, send-key behavior, foreground sync frequency, automatic image previews, and recycle-bin policy are represented in the versioned settings schemas; unavailable future capabilities remain disabled in the interface rather than being emulated inaccurately.

## Schema evolution

All persisted JSON includes `schemaVersion`. Readers must validate remote content and remain capable of reporting unsupported future versions without overwriting them.
