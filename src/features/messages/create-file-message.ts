import {
  fileMessageSchema,
  type Attachment,
  type FileMessage,
} from "../../domain/message";

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
