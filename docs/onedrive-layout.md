# OneDrive storage contract

Status: approved architecture; implementation deferred.

## Root

OneDrop stores its data beneath the Microsoft Graph App Folder at `/me/drive/special/approot` using delegated `Files.ReadWrite.AppFolder` access.

## Monthly records

`messages/YYYY-MM.json` is the canonical metadata document for a UTC month. Only the current month is mutable. A conditional ETag write is mandatory for every update.

Historical documents are not rewritten by normal send behavior. OneDrop does not automatically replay failed or offline sends into historical months.

## Attachments

Attachment bytes live under `files/YYYY/MM/<message-id>/`. A message record refers to the returned DriveItem ID, original name, MIME type, size, and content identity information that is available from Graph.

## Deletion

Deletion semantics are deferred. The reserved `tombstones/YYYY-MM.json` namespace allows devices to observe deletions without requiring in-place removal to be the only signal. Its concurrency protocol must match monthly message documents.

## Schema evolution

All persisted JSON includes `schemaVersion`. Readers must validate remote content and remain capable of reporting unsupported future versions without overwriting them.
