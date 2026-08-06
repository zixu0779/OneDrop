# OneDrive storage contract

Status: root compatibility check implemented; storage operations deferred.

The root App Folder lookup and current-month read are implemented as user-triggered compatibility checks. Monthly writes, attachments, and tombstones remain deferred.

## Root

OneDrop stores its data beneath the Microsoft Graph App Folder at `/me/drive/special/approot` using delegated `Files.ReadWrite.AppFolder` access.

The first successful lookup can create the application folder in OneDrive. The current validation UI displays the returned DriveItem name and ID and, when available, its OneDrive web URL. It does not create any children beneath that folder.

The `/special/approot` endpoint is the identity boundary for this lookup. The client validates the returned DriveItem ID and name but does not reject a successful response when an optional `specialFolder` facet is omitted. OneDrive may localize the visible name of its parent `Apps` special folder; clients must use the `approot` alias or DriveItem IDs rather than localized path text.

## Monthly records

`messages/YYYY-MM.json` is the canonical metadata document for a UTC month. Only the current month is mutable. A conditional ETag write is mandatory for every update.

Historical documents are not rewritten by normal send behavior. OneDrop does not automatically replay failed or offline sends into historical months.

The read-only stage requests the current UTC month's DriveItem metadata first. HTTP 404 is interpreted as an empty timeline, not an error. An existing document must expose an ETag and pass the versioned Zod schema before it is displayed.

## Attachments

Attachment bytes live under `files/YYYY/MM/<message-id>/`. A message record refers to the returned DriveItem ID, original name, MIME type, size, and content identity information that is available from Graph.

## Deletion

Deletion semantics are deferred. The reserved `tombstones/YYYY-MM.json` namespace allows devices to observe deletions without requiring in-place removal to be the only signal. Its concurrency protocol must match monthly message documents.

## Schema evolution

All persisted JSON includes `schemaVersion`. Readers must validate remote content and remain capable of reporting unsupported future versions without overwriting them.
