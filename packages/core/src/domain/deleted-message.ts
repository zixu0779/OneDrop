import type { Message } from "./message";

export type DeletedMessageKind = "text" | "file" | "image";

export type DeletedMessageItem = {
  message: Message;
  originalMonth: string;
  deletedAt: string;
  kind: DeletedMessageKind;
  recovery?: "forever" | string;
};
