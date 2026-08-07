# OneDrive storage contract

Status: root check, cached monthly reads, and active-month chunk writes implemented; archive compaction, attachments, and deletion deferred.

The root App Folder lookup, current-month read, and text message write are implemented. Attachments and tombstones remain deferred.

## Root

OneDrop stores its data beneath the Microsoft Graph App Folder at `/me/drive/special/approot` using delegated `Files.ReadWrite.AppFolder` access.

The first successful lookup can create the application folder in OneDrive. The current validation UI displays the returned DriveItem name and ID and, when available, its OneDrive web URL. It does not create any children beneath that folder.

The `/special/approot` endpoint is the identity boundary for this lookup. The client validates the returned DriveItem ID and name but does not reject a successful response when an optional `specialFolder` facet is omitted. OneDrive may localize the visible name of its parent `Apps` special folder; clients must use the `approot` alias or DriveItem IDs rather than localized path text.

## Monthly records

`messages/YYYY-MM/NNNN.json` is the active metadata layout for a UTC month. Only the current month is mutable. A conditional ETag write is mandatory for every existing-chunk update.

The obsolete `messages/YYYY-MM.json` layout is outside the protocol: OneDrop does not probe, read, migrate, or delete those files. Historical documents are not rewritten by normal send behavior. OneDrop does not automatically replay failed or offline sends into historical months.

The reader enumerates the current UTC month's chunk directory with Graph pagination. HTTP 404 is interpreted as an empty timeline, not an error. Every chunk must expose an ETag and pass the versioned Zod schema before its messages are displayed.

The first text send creates the month folder and `0001.json`. Subsequent sends replace the active chunk only when its previously read ETag still matches. Once adding a message would exceed the 256 KiB soft target, the writer creates the deterministic successor instead. Every individual chunk has a 320 KiB hard ceiling. A validated snapshot and folder IDs are cached in IndexedDB. Old cache records that contain no chunk metadata are invalidated automatically. The normal subsequent-send path therefore performs one conditional upload. Create and update conflicts invalidate the snapshot, then re-read, merge by immutable message ID, and retry within a fixed budget.

A network failure after an upload starts is ambiguous: OneDrive might have accepted the request even though OneDrop did not receive the response. OneDrop invalidates the cached snapshot and reports failure; it does not automatically replay the message. The next read must reconcile with OneDrive first.

## Active-month chunks

The mutable current UTC month uses deterministic chunk files with a 256 KiB soft target and 320 KiB hard ceiling. No shared `current.json` pointer is used. Readers enumerate chunk children with Graph pagination. Writers derive the active chunk from validated metadata and create deterministic successors with conflict behavior `fail`.

After a month closes and a 24-hour grace period passes, OneDrop may merge that month's chunks into one immutable `archive/YYYY-MM.json`. Archive publication must use create-with-conflict-fail, validate the merged result, and retain source chunks until cleanup is independently safe. This reduces hot-file rewrite cost without permanently exposing users to many small historical files.

## Attachments

Attachment bytes live under `files/YYYY/MM/<message-id>/`. A message record refers to the returned DriveItem ID, original name, MIME type, size, and content identity information that is available from Graph.

## Deletion

Deletion implementation is deferred, but its product scope is limited to individual messages. OneDrop will not offer deletion of an entire month. Versioned tombstones will identify the message ID, original month, and deletion timestamp so the same rule can filter active chunks and archive files. The tombstone write protocol must use the same bounded conflict handling as message metadata.

## Schema evolution

All persisted JSON includes `schemaVersion`. Readers must validate remote content and remain capable of reporting unsupported future versions without overwriting them.
