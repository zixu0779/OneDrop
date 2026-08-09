import { oneDropDatabase, type PendingTransferRecord } from "./database";

export function listPendingTransfers(): Promise<PendingTransferRecord[]> {
  return oneDropDatabase.pendingTransfers.orderBy("createdAt").toArray();
}

export function getPendingTransfer(
  id: string,
): Promise<PendingTransferRecord | undefined> {
  return oneDropDatabase.pendingTransfers.get(id);
}

export function putPendingTransfer(
  transfer: PendingTransferRecord,
): Promise<string> {
  return oneDropDatabase.pendingTransfers.put(transfer);
}

export function deletePendingTransfer(id: string): Promise<void> {
  return oneDropDatabase.pendingTransfers.delete(id);
}

export function updatePendingTransfer(
  id: string,
  patch: Partial<PendingTransferRecord>,
): Promise<number> {
  return oneDropDatabase.pendingTransfers.update(id, patch);
}
