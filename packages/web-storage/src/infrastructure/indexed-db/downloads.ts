import { oneDropDatabase, type DownloadRecord } from "./database";

export function getDownloadRecord(
  driveItemId: string,
): Promise<DownloadRecord | undefined> {
  return oneDropDatabase.downloads.get(driveItemId);
}

export function putDownloadRecord(record: DownloadRecord): Promise<string> {
  return oneDropDatabase.downloads.put(record);
}

export function deleteDownloadRecord(driveItemId: string): Promise<void> {
  return oneDropDatabase.downloads.delete(driveItemId);
}

export function markDownloadOpened(
  driveItemId: string,
  localFilename: string | undefined,
): Promise<number> {
  return oneDropDatabase.downloads.update(driveItemId, {
    ...(localFilename ? { localFilename } : {}),
    lastOpenedAt: new Date().toISOString(),
  });
}
