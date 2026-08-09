# OneDrive storage contract

Status: root checks, cached monthly reads, lazy historical-month loading, active-month chunk writes, immutable historical-month archives with safe source cleanup, small-file attachments, and logical single-message deletion are implemented; physical attachment cleanup remains deferred.

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

The scheduler applies tombstones, publishes immutable `archive/YYYY-MM.json` with create-with-conflict-fail, and reads it back before recording success. A concurrently published byte-equivalent archive is accepted. A successful month is never archived again; later deletions remain tombstones applied at read time. Transient failures use persisted retry delays of 5 minutes, 30 minutes, 6 hours, then 24 hours, checked during later synchronizations. Manual Retry bypasses only the delay and shares the same per-month in-flight task. Damaged or conflicting sources and unverifiable existing archives are blocked rather than overwritten.

The first later synchronization after a verified publication reads the raw archive again, compares its SHA-256 digest with the recorded publication, confirms tombstones can still be applied, and only then deletes `messages/YYYY-MM/`. Cleanup failure leaves the successful archive state intact and is retried during later synchronizations. Archive status never delays foreground synchronization or history loading. Failures are exposed through the existing non-blocking centered notification stack; an open failure card is updated in place for automatic or manual retry and success.

## Attachments

Attachment bytes live under `files/YYYY/MM/<message-id>/`. A message record refers to the returned DriveItem ID, original name, MIME type, and size.

New image records may additionally store the original pixel dimensions and a Base64-encoded ThumbHash. OneDrop generates the hash locally from a canvas no larger than 100 pixels on its longest edge. The hash is only a compact visual approximation used for a blurred placeholder while the original image is loading or unavailable; it is not a separate OneDrive file and cannot reconstruct the original image. Older records without these optional fields remain valid and use the generic placeholder.

## Deletion

Deletion is limited to individual messages. OneDrop does not offer deletion of an entire month. Versioned tombstones in `tombstones/YYYY-MM.json` identify the message ID, original month, and deletion timestamp. Existing tombstone documents are replaced with their exact ETag; create and update conflicts are re-read and retried within a five-attempt budget. Current-month, historical-chunk, and archive readers apply tombstones before returning messages or conflict notices. Deletion is logical: message chunks, archives, OneDrive attachments, and user-downloaded files are not physically removed.

## Schema evolution

All persisted JSON includes `schemaVersion`. Readers must validate remote content and remain capable of reporting unsupported future versions without overwriting them.
