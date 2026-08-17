import {
  textMessageSchema,
  type TextMessage,
} from "@onedrop/core/domain/message";

export function createTextMessage(
  text: string,
  now = new Date(),
  id: string = crypto.randomUUID(),
  senderDeviceId?: string,
): TextMessage {
  return textMessageSchema.parse({
    schemaVersion: 1,
    id,
    type: "text",
    createdAt: now.toISOString(),
    ...(senderDeviceId ? { senderDeviceId } : {}),
    text,
  });
}
