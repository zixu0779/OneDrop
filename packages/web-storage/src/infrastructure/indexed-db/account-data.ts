import { oneDropDatabase } from "./database";

export async function pauseAccountTransfers(ids: string[]): Promise<void> {
  await oneDropDatabase.pendingTransfers
    .where("id")
    .anyOf(ids)
    .and((record) => record.status === "uploading")
    .modify({ pausedForAccountChange: true });
}
export async function claimPausedTransfer(id: string): Promise<boolean> {
  const db = oneDropDatabase;
  return db.transaction("rw", db.pendingTransfers, async () => {
    const record = await db.pendingTransfers.get(id);
    if (!record?.pausedForAccountChange || record.status === "cancelled")
      return false;
    await db.pendingTransfers.update(id, { pausedForAccountChange: false });
    return true;
  });
}
export async function claimPausedText(id: string): Promise<boolean> {
  const db = oneDropDatabase;
  return db.transaction("rw", db.pendingTexts, async () => {
    if (!(await db.pendingTexts.get(id))?.pausedForAccountChange) return false;
    await db.pendingTexts.update(id, { pausedForAccountChange: false });
    return true;
  });
}

export async function deletePendingMessage(id: string): Promise<void> {
  const db = oneDropDatabase;
  await db.transaction("rw", db.pendingTexts, db.pendingTransfers, async () => {
    await db.pendingTexts.delete(id);
    await db.pendingTransfers.delete(id);
  });
}
