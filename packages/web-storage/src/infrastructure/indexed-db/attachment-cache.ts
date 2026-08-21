import { oneDropDatabase, type AttachmentCacheRecord } from "./database";

export function getAttachmentCache(
  driveItemId: string,
): Promise<AttachmentCacheRecord | undefined> {
  return oneDropDatabase.attachmentCache.get(driveItemId);
}

export function putAttachmentCache(
  record: AttachmentCacheRecord,
): Promise<string> {
  return oneDropDatabase.attachmentCache.put(record);
}

export function deleteAttachmentCache(driveItemId: string): Promise<void> {
  return oneDropDatabase.attachmentCache.delete(driveItemId);
}
