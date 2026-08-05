import { z } from "zod";

export const messageSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  type: z.enum(["text", "file"]),
  createdAt: z.iso.datetime(),
  text: z.string().optional(),
});

export type Message = z.infer<typeof messageSchema>;
