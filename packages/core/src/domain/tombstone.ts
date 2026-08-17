import { z } from "zod";

const monthPattern = /^\d{4}-\d{2}$/u;

export const messageTombstoneSchema = z.object({
  schemaVersion: z.literal(1),
  messageId: z.uuid(),
  originalMonth: z.string().regex(monthPattern),
  deletedAt: z.iso.datetime(),
  recovery: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("disabled") }),
      z.object({
        mode: z.literal("retention"),
        retention: z.union([
          z.literal(3),
          z.literal(7),
          z.literal(10),
          z.literal(30),
          z.literal("forever"),
        ]),
        recoverableUntil: z.iso.datetime().optional(),
      }),
    ])
    .optional(),
});

export const tombstoneDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  month: z.string().regex(monthPattern),
  tombstones: z.array(messageTombstoneSchema),
});

export type MessageTombstone = z.infer<typeof messageTombstoneSchema>;
export type TombstoneDocument = z.infer<typeof tombstoneDocumentSchema>;
