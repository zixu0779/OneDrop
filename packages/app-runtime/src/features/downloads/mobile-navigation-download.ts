import type { Attachment } from "@onedrop/core/domain/message";
import type { MobileDownloadStatus } from "@onedrop/core/contracts/runtime-messages";
import { getAttachmentDownloadUrl } from "@onedrop/onedrive/infrastructure/onedrive/file-uploader";
import { sanitizeDownloadFilename } from "./download-service";

const STORAGE_KEY_PREFIX = "mobileNavigationDownload:";
const WAITING_TIMEOUT_MS = 15_000;

export type { MobileDownloadStatus } from "@onedrop/core/contracts/runtime-messages";

export async function prepareMobileNavigationDownload(
  attachment: Attachment,
): Promise<MobileDownloadStatus> {
  const now = Date.now();
  const task: MobileDownloadStatus = {
    driveItemId: attachment.driveItemId,
    state: "waiting",
    filename: sanitizeDownloadFilename(attachment.name),
    sourceUrl: await getAttachmentDownloadUrl(attachment.driveItemId),
    startedAt: now,
    updatedAt: now,
    lastActivityAt: now,
    bytesReceived: 0,
    totalBytes: attachment.size,
  };
  await writeTask(task);
  return task;
}

export async function claimMobileNavigationDownload(
  item: Browser.downloads.DownloadItem,
): Promise<void> {
  const candidates = (await listTasks())
    .filter(
      (task) =>
        task.state === "waiting" &&
        Date.now() - task.startedAt < 60_000 &&
        (item.url === task.sourceUrl ||
          item.finalUrl === task.sourceUrl ||
          basename(item.filename) === task.filename),
    )
    .sort((left, right) => right.startedAt - left.startedAt);
  const task = candidates[0];
  if (!task) return;
  const now = Date.now();
  await writeTask({
    ...task,
    state: item.state === "complete" ? "complete" : "downloading",
    downloadId: item.id,
    bytesReceived: item.bytesReceived,
    totalBytes: positiveTotal(item.totalBytes, task.totalBytes),
    updatedAt: now,
    lastActivityAt: now,
    lastFingerprint: fingerprint(item),
  });
}

export async function readMobileNavigationDownloadStatus(
  driveItemId: string,
): Promise<MobileDownloadStatus | undefined> {
  const task = await readTask(driveItemId);
  if (!task) return undefined;
  const now = Date.now();
  if (task.state === "waiting") {
    if (now - task.lastActivityAt >= WAITING_TIMEOUT_MS) {
      const failed = {
        ...task,
        state: "failed" as const,
        error: "Download canceled.",
        updatedAt: now,
      };
      await writeTask(failed);
      return failed;
    }
    return task;
  }
  if (task.state !== "downloading" || task.downloadId === undefined)
    return task;

  const [item] = await browser.downloads.search({ id: task.downloadId });
  if (!item) {
    const failed = {
      ...task,
      state: "failed" as const,
      error: "Download failed.",
      updatedAt: now,
    };
    await writeTask(failed);
    return failed;
  }
  if (item.state === "complete") {
    const complete = {
      ...task,
      state: "complete" as const,
      bytesReceived: item.bytesReceived,
      totalBytes: positiveTotal(item.totalBytes, task.totalBytes),
      updatedAt: now,
    };
    await writeTask(complete);
    return complete;
  }
  if (item.state === "interrupted") {
    const failed = {
      ...task,
      state:
        item.error === "USER_CANCELED"
          ? ("cancelled" as const)
          : ("failed" as const),
      error:
        item.error === "USER_CANCELED"
          ? "Download canceled."
          : item.error
            ? `Download failed: ${item.error}.`
            : "Download failed.",
      updatedAt: now,
    };
    await writeTask(failed);
    return failed;
  }

  const nextFingerprint = fingerprint(item);
  const changed = nextFingerprint !== task.lastFingerprint;
  if (!changed && now - task.lastActivityAt >= WAITING_TIMEOUT_MS) {
    await removeDownload(task.downloadId);
    const failed = {
      ...task,
      state: "failed" as const,
      error: "Download canceled.",
      updatedAt: now,
    };
    await writeTask(failed);
    return failed;
  }
  const downloading = {
    ...task,
    bytesReceived: item.bytesReceived,
    totalBytes: positiveTotal(item.totalBytes, task.totalBytes),
    updatedAt: now,
    ...(changed
      ? { lastActivityAt: now, lastFingerprint: nextFingerprint }
      : {}),
  };
  await writeTask(downloading);
  return downloading;
}

export async function cancelMobileNavigationDownload(
  driveItemId: string,
): Promise<void> {
  const task = await readTask(driveItemId);
  if (!task) return;
  if (task.downloadId !== undefined) await removeDownload(task.downloadId);
  await removeTask(driveItemId);
}

export async function clearMobileNavigationDownload(
  driveItemId: string,
): Promise<void> {
  await removeTask(driveItemId);
}

async function removeDownload(downloadId: number): Promise<void> {
  await browser.downloads.cancel(downloadId).catch(() => undefined);
  await browser.downloads.removeFile(downloadId).catch(() => undefined);
  await browser.downloads.erase({ id: downloadId }).catch(() => undefined);
}

function fingerprint(item: Browser.downloads.DownloadItem): string {
  return [
    item.state,
    item.bytesReceived,
    item.totalBytes,
    item.filename,
    item.error ?? "",
  ].join("|");
}

function positiveTotal(primary: number, fallback: number): number {
  return primary > 0 ? primary : fallback;
}

function basename(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function storageKey(driveItemId: string): string {
  return `${STORAGE_KEY_PREFIX}${driveItemId}`;
}

async function readTask(
  driveItemId: string,
): Promise<MobileDownloadStatus | undefined> {
  const key = storageKey(driveItemId);
  const stored = await browser.storage.local.get(key);
  return stored[key] as MobileDownloadStatus | undefined;
}

async function listTasks(): Promise<MobileDownloadStatus[]> {
  const stored = await browser.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    .map(([, value]) => value as MobileDownloadStatus);
}

async function writeTask(task: MobileDownloadStatus): Promise<void> {
  await browser.storage.local.set({ [storageKey(task.driveItemId)]: task });
}

async function removeTask(driveItemId: string): Promise<void> {
  await browser.storage.local.remove(storageKey(driveItemId));
}
