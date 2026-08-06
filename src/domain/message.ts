import { z } from "zod";

const messageBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const textMessageSchema = messageBaseSchema.extend({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(20_000),
});

export const fileMessageSchema = messageBaseSchema.extend({
  type: z.literal("file"),
  attachment: z.object({
    driveItemId: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    mimeType: z.string().min(1),
  }),
});

export const messageSchema = z.discriminatedUnion("type", [
  textMessageSchema,
  fileMessageSchema,
]);

export type Message = z.infer<typeof messageSchema>;
export type TextMessage = z.infer<typeof textMessageSchema>;
