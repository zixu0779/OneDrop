import type {
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import { oneDropDatabase } from "@onedrop/web-storage/infrastructure/indexed-db/database";
const texts = new Set<string>();
const files = new Set<string>();
export function trackAccountWork(
  kind: "text" | "file",
  id: string,
): () => void {
  const active = kind === "text" ? texts : files;
  active.add(id);
  return () => active.delete(id);
}
export async function pauseLocalAccountWork(): Promise<void> {
  await Promise.all([
    ...[...texts].map((id) =>
      oneDropDatabase.pendingTexts.update(id, { pausedForAccountChange: true }),
    ),
    ...[...files].map((id) =>
      oneDropDatabase.pendingTransfers.update(id, {
        pausedForAccountChange: true,
      }),
    ),
  ]);
}

export async function persistPausedResponse(
  request: RuntimeRequest,
  response: RuntimeResponse,
): Promise<void> {
  if (response.ok || !response.accountPaused) return;
  const db = oneDropDatabase;
  if (request.type === "messages/send-text" && request.messageId) {
    await db.pendingTexts.update(request.messageId, {
      pausedForAccountChange: true,
    });
  } else if (request.type === "files/send") {
    await db.transaction("rw", db.pendingTransfers, async () => {
      const record = await db.pendingTransfers.get(request.messageId);
      if (record && record.status !== "cancelled")
        await db.pendingTransfers.update(request.messageId, {
          pausedForAccountChange: true,
        });
    });
  }
}
