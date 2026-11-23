import { currentAccountScope } from "@onedrop/app-runtime/features/auth/account-context";
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
    accountScope: currentAccountScope(),
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

let registryWork: Promise<unknown> = Promise.resolve();
function mutateRegistry<T>(operation: () => Promise<T>): Promise<T> {
  const work = registryWork.then(operation);
  registryWork = work.catch(() => undefined);
  return work;
}
export async function removeMobileAccountTasks(scope: string): Promise<void> {
  await mutateRegistry(async () => {
    const saved = await browser.storage.local.get(null);
    const prefix = `onedrop.edge.${scope}.${STORAGE_KEY_PREFIX}`;
    await browser.storage.local.remove(
      Object.keys(saved).filter((key) => key.startsWith(prefix)),
    );
  });
}
export function claimMobileNavigationDownload(
  item: Browser.downloads.DownloadItem,
): Promise<void> {
  return mutateRegistry(() => claimDownload(item));
}
async function claimDownload(
  item: Browser.downloads.DownloadItem,
): Promise<void> {
  const candidates = (await listTasks())
    .filter(
      (task) =>
        task.state === "waiting" &&
        Date.now() - task.startedAt < 60_000 &&
        (item.url === task.sourceUrl || item.finalUrl === task.sourceUrl),
    )
    .sort((left, right) => right.startedAt - left.startedAt);
  const exact = candidates.filter(
    (task) => item.url === task.sourceUrl || item.finalUrl === task.sourceUrl,
  );
  const matching = exact.length ? exact : candidates;
  const task = matching.length === 1 ? matching[0] : undefined;
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

function storageKey(
  driveItemId: string,
  scope = currentAccountScope(),
): string {
  return `onedrop.edge.${scope}.${STORAGE_KEY_PREFIX}${driveItemId}`;
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
    .filter(
      ([key]) =>
        key.startsWith("onedrop.edge.") &&
        key.includes(`.${STORAGE_KEY_PREFIX}`),
    )
    .map(([, value]) => value as MobileDownloadStatus);
}

async function writeTask(task: MobileDownloadStatus): Promise<void> {
  await browser.storage.local.set({
    [storageKey(task.driveItemId, task.accountScope)]: task,
  });
}

async function removeTask(driveItemId: string): Promise<void> {
  await browser.storage.local.remove(storageKey(driveItemId));
}
