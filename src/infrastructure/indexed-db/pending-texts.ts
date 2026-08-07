import { oneDropDatabase, type PendingTextRecord } from "./database";

export function listPendingTexts(): Promise<PendingTextRecord[]> {
  return oneDropDatabase.pendingTexts.orderBy("createdAt").toArray();
}

export function putPendingText(record: PendingTextRecord): Promise<string> {
  return oneDropDatabase.pendingTexts.put(record);
}

export function updatePendingText(
  id: string,
  patch: Partial<PendingTextRecord>,
): Promise<number> {
  return oneDropDatabase.pendingTexts.update(id, patch);
}

export function deletePendingText(id: string): Promise<void> {
  return oneDropDatabase.pendingTexts.delete(id);
}
