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
  const baseFilename = sanitizeDownloadFilename(attachment.name);
  const attemptedFilenames = new Set<string>();
  let completed:
    { downloadId: number; item: Browser.downloads.DownloadItem } | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const filename = saveAs
      ? baseFilename
      : await chooseAvailableDownloadFilename(baseFilename, attemptedFilenames);
    attemptedFilenames.add(filename);
    const downloadId = await browser.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: "uniquify",
      saveAs,
    });
    try {
      completed = {
        downloadId,
        item: await waitForCompletedDownload(downloadId),
      };
      break;
    } catch (error) {
      if (
        saveAs ||
        !(error instanceof DownloadInterruptedError) ||
        error.reason !== "FILE_EXISTS" ||
        attempt === 2
      ) {
        throw error;
      }
    }
  }
  if (!completed) throw new Error("The download did not complete.");
  const { downloadId, item } = completed;
  await putDownloadRecord({
    driveItemId: attachment.driveItemId,
    downloadId,
    cloudName: attachment.name,
    ...(item.filename ? { localFilename: item.filename } : {}),
    createdAt: new Date().toISOString(),
  });
  return { action: "downloaded", downloadId };
}

async function chooseAvailableDownloadFilename(
  baseFilename: string,
  reserved: ReadonlySet<string>,
): Promise<string> {
  const downloads = await browser.downloads.search({});
  const occupied = new Set(
    downloads
      .filter(
        (item) =>
          item.exists !== false &&
          (item.state === "complete" || item.state === "in_progress"),
      )
      .map((item) => getPathBasename(item.filename).toLocaleLowerCase()),
  );
  for (const filename of reserved) {
    occupied.add(filename.toLocaleLowerCase());
  }
  if (!occupied.has(baseFilename.toLocaleLowerCase())) return baseFilename;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = appendFilenameSuffix(baseFilename, ` (${index})`);
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return appendFilenameSuffix(baseFilename, `-${Date.now()}`);
}

function getPathBasename(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function appendFilenameSuffix(filename: string, suffix: string): string {
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) return `${filename}${suffix}`;
  return `${filename.slice(0, extensionIndex)}${suffix}${filename.slice(extensionIndex)}`;
}

async function waitForCompletedDownload(
  downloadId: number,
): Promise<Browser.downloads.DownloadItem> {
  const readDownload = async () =>
    (await browser.downloads.search({ id: downloadId }))[0];
  const initial = await readDownload();
  if (initial?.state === "complete" && initial.exists !== false) return initial;
  if (initial?.state === "interrupted") {
    throw downloadInterruptedError(initial.error);
  }

  return new Promise((resolve, reject) => {
    const finish = async () => {
      const item = await readDownload();
      if (item?.state === "complete" && item.exists !== false) {
        browser.downloads.onChanged.removeListener(onChanged);
        resolve(item);
      } else if (item?.state === "interrupted") {
        browser.downloads.onChanged.removeListener(onChanged);
        reject(downloadInterruptedError(item.error));
      }
    };
    const onChanged = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id === downloadId) void finish();
    };
    browser.downloads.onChanged.addListener(onChanged);
    // Close the gap between the first search and listener registration.
    void finish();
  });
}

class DownloadInterruptedError extends Error {
  constructor(readonly reason: string | undefined) {
    super(
      reason === "FILE_EXISTS"
        ? "The download was blocked because the file already exists."
        : `The download was interrupted${reason ? `: ${reason}` : "."}`,
    );
  }
}

function downloadInterruptedError(
  reason: string | undefined,
): DownloadInterruptedError {
  return new DownloadInterruptedError(reason);
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
