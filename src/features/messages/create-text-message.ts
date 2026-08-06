import { textMessageSchema, type TextMessage } from "../../domain/message";

export function createTextMessage(
  text: string,
  now = new Date(),
  id = crypto.randomUUID(),
): TextMessage {
  return textMessageSchema.parse({
    schemaVersion: 1,
    id,
    type: "text",
    createdAt: now.toISOString(),
    text,
  });
}
