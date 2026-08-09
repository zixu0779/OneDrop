import type { Attachment } from "../../domain/message";
import {
  deleteDownloadRecord,
  getDownloadRecord,
  markDownloadOpened,
  putDownloadRecord,
} from "../../infrastructure/indexed-db/downloads";
import { getAttachmentDownloadUrl } from "../../infrastructure/onedrive/file-uploader";

export async function openOrDownloadAttachment(
  attachment: Attachment,
  saveAs: boolean,
  forceDownload = false,
): Promise<
  | { action: "open"; downloadId: number }
  | { action: "downloaded"; downloadId: number }
> {
  if (!saveAs && !forceDownload) {
    const existing = await openExistingDownload(attachment.driveItemId);
    if (existing) {
      return existing.isDownloading
        ? { action: "downloaded", downloadId: existing.downloadId }
        : { action: "open", downloadId: existing.downloadId };
    }
  }

  const downloadUrl = await getAttachmentDownloadUrl(attachment.driveItemId);
  const downloadId = await browser.downloads.download({
    url: downloadUrl,
    filename: sanitizeDownloadFilename(attachment.name),
    conflictAction: "uniquify",
    saveAs,
  });
  const [item] = await browser.downloads.search({ id: downloadId });
  await putDownloadRecord({
    driveItemId: attachment.driveItemId,
    downloadId,
    cloudName: attachment.name,
    ...(item?.filename ? { localFilename: item.filename } : {}),
    createdAt: new Date().toISOString(),
  });
  return { action: "downloaded", downloadId };
}

async function openExistingDownload(
  driveItemId: string,
): Promise<{ downloadId: number; isDownloading: boolean } | false> {
  const record = await getDownloadRecord(driveItemId);
  if (!record) return false;

  const [item] = await browser.downloads.search({ id: record.downloadId });
  if (!item || item.exists === false || item.state === "interrupted") {
    await deleteDownloadRecord(driveItemId);
    return false;
  }

  if (item.state === "in_progress") {
    return { downloadId: record.downloadId, isDownloading: true };
  }

  await markDownloadOpened(driveItemId, item.filename);
  return { downloadId: record.downloadId, isDownloading: false };
}

export function sanitizeDownloadFilename(name: string): string {
  const printableName = Array.from(name, (character) =>
    character.charCodeAt(0) < 32 ? "_" : character,
  ).join("");
  const sanitized = printableName
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return sanitized || "download";
}
