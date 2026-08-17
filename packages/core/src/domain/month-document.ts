import { z } from "zod";

import { messageSchema } from "./message";

export const monthDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  messages: z.array(messageSchema),
});

export type MonthDocument = z.infer<typeof monthDocumentSchema>;
