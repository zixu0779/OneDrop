import {
  fileMessageSchema,
  uploadingFileMessageSchema,
  type Attachment,
  type FileMessage,
  type UploadingFileMessage,
} from "@onedrop/core/domain/message";

export function createFileMessage(
  attachment: Attachment,
  senderDeviceId: string,
  now = new Date(),
  id: string = crypto.randomUUID(),
): FileMessage {
  return fileMessageSchema.parse({
    schemaVersion: 1,
    id,
    type: "file",
    createdAt: now.toISOString(),
    senderDeviceId,
    attachment,
  });
}

export function createUploadingFileMessage(
  pendingAttachment: UploadingFileMessage["pendingAttachment"],
  senderDeviceId: string,
  now: Date,
  id: string,
): UploadingFileMessage {
  return uploadingFileMessageSchema.parse({
    schemaVersion: 1,
    id,
    type: "file-uploading",
    createdAt: now.toISOString(),
    senderDeviceId,
    pendingAttachment,
  });
}
