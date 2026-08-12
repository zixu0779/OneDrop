import type {
  RuntimeRequest,
  RuntimeResponse,
} from "../src/contracts/runtime-messages";
import {
  getAuthStatus,
  signIn,
  signOut,
} from "../src/features/auth/auth-service";
import { verifyAppFolder } from "../src/infrastructure/onedrive/app-folder";
import { createTextMessage } from "../src/features/messages/create-text-message";
import { getUtcMonth } from "../src/features/messages/month";
import {
  readHistoricalMonthDocument,
  readMonthDocument,
} from "../src/infrastructure/onedrive/month-reader";
import { appendTextMessage } from "../src/infrastructure/onedrive/month-writer";
import { getOrCreateDeviceId } from "../src/features/device/device-service";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "../src/features/messages/create-file-message";
import {
  checkAttachmentExists,
  getAttachmentWebUrl,
  readImagePreview,
  uploadLargeFile,
  uploadSmallFile,
} from "../src/infrastructure/onedrive/file-uploader";
import { MAX_DIRECT_FILE_BYTES } from "../src/config/files";
import { getPendingTransfer } from "../src/infrastructure/indexed-db/pending-transfers";
import {
  appendMessage,
  removeMessage,
  resolveMessageConflict,
  replaceMessage,
} from "../src/infrastructure/onedrive/month-writer";
import { openOrDownloadAttachment } from "../src/features/downloads/download-service";
import {
  deleteCorruptMonthFile,
  getCorruptMonthFileFolderUrl,
} from "../src/infrastructure/onedrive/corrupt-month-file";
import { deleteMonthCache } from "../src/infrastructure/indexed-db/sync-cache";
import { rebuildTestData } from "../src/dev/rebuild-test-data";
import { writeMessageTombstone } from "../src/infrastructure/onedrive/tombstones";
import {
  checkArchiveTasks,
  dismissArchiveNotice,
  resetArchiveTasks,
  resumeArchiveTasksAfterSignIn,
  retryArchiveTask,
} from "../src/infrastructure/onedrive/archive-scheduler";
import {
  cleanDeletedDataNow,
  checkAttachmentCleanup,
  resetAttachmentCleanup,
} from "../src/infrastructure/onedrive/attachment-cleanup";
import { enqueueMonthWrite } from "../src/infrastructure/onedrive/month-write-coordinator";

const activeFileUploads = new Map<string, AbortController>();
const cancelledFileUploads = new Set<string>();

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  browser.runtime.onMessage.addListener(
    async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      try {
        switch (request.type) {
          case "auth/status":
            return {
              ok: true,
              type: "auth/status",
              status: await getAuthStatus(),
            };
          case "auth/sign-in": {
            const status = await signIn();
            if (status.state === "signed-in") {
              await resumeArchiveTasksAfterSignIn();
            }
            return { ok: true, type: "auth/status", status };
          }
          case "auth/sign-out": {
            const status = await signOut();
            await resetAttachmentCleanup();
            return { ok: true, type: "auth/status", status };
          }
          case "device/id":
            return {
              ok: true,
              type: "device/id",
              deviceId: await getOrCreateDeviceId(),
            };
          case "dev/rebuild-test-data":
            if (!import.meta.env.DEV) {
              throw new Error("Test data rebuilding is development-only.");
            }
            await resetArchiveTasks();
            await resetAttachmentCleanup();
            await rebuildTestData();
            return { ok: true, type: "dev/test-data-rebuilt" };
          case "onedrive/verify-app-folder":
            return {
              ok: true,
              type: "onedrive/app-folder",
              appFolder: await verifyAppFolder(),
            };
          case "onedrive/open-app-folder": {
            const appFolder = await verifyAppFolder();
            if (!appFolder.webUrl) {
              throw new Error(
                "OneDrive did not provide the OneDrop folder link.",
              );
            }
            await browser.tabs.create({ url: appFolder.webUrl });
            return { ok: true, type: "onedrive/app-folder-opened" };
          }
          case "messages/read-current-month":
            return {
              ok: true,
              type: "messages/month",
              result: await readMonthDocument(getUtcMonth()),
            };
          case "messages/read-month":
            return {
              ok: true,
              type: "messages/month",
              result: await readHistoricalMonthDocument(request.month),
            };
          case "archives/check":
            return {
              ok: true,
              type: "archives/notices",
              notices: await checkArchiveTasks(),
            };
          case "archives/retry": {
            const notice = await retryArchiveTask(request.month);
            return {
              ok: true,
              type: "archives/notice",
              ...(notice ? { notice } : {}),
            };
          }
          case "archives/dismiss":
            await dismissArchiveNotice(request.month);
            return { ok: true, type: "archives/dismissed" };
          case "messages/delete":
            return enqueueMonthWrite(async () => {
              await writeMessageTombstone(request.month, request.messageId);
              return {
                ok: true,
                type: "messages/deleted",
                result:
                  request.month === getUtcMonth()
                    ? await readMonthDocument(request.month)
                    : await readHistoricalMonthDocument(request.month),
              };
            });
          case "messages/delete-corrupt-file":
            await deleteCorruptMonthFile(request.itemId);
            await deleteMonthCache(getUtcMonth());
            return { ok: true, type: "messages/corrupt-file-deleted" };
          case "messages/open-corrupt-file-location":
            await browser.tabs.create({
              url: await getCorruptMonthFileFolderUrl(request.itemId),
            });
            return {
              ok: true,
              type: "messages/corrupt-file-location-opened",
            };
          case "messages/resolve-conflict":
            return enqueueMonthWrite(async () => ({
              ok: true,
              type: "messages/conflict-resolved",
              result: await resolveMessageConflict(
                getUtcMonth(),
                request.messageId,
                request.keepItemId,
              ),
            }));
          case "messages/send-text": {
            const message = createTextMessage(
              request.text,
              request.createdAt ? new Date(request.createdAt) : new Date(),
              request.messageId ?? crypto.randomUUID(),
              await getOrCreateDeviceId(),
            );
            return enqueueMonthWrite(async () => ({
              ok: true,
              type: "messages/month",
              result: await appendTextMessage(getUtcMonth(), message),
            }));
          }
          case "files/send": {
            cancelledFileUploads.delete(request.messageId);
            const deviceId = await getOrCreateDeviceId();
            const registeredAt = new Date(request.createdAt);
            const placeholder = createUploadingFileMessage(
              request.file,
              deviceId,
              registeredAt,
              request.messageId,
            );
            try {
              await enqueueMonthWrite(() =>
                appendMessage(getUtcMonth(), placeholder),
              );
            } catch (error) {
              try {
                await enqueueMonthWrite(() =>
                  removeMessage(getUtcMonth(), request.messageId),
                );
              } catch {
                // The local pending transfer retains cleanup responsibility
                // and will retry discarding this placeholder after reconnect.
              }
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "upload-failed",
                  error: getErrorMessage(error),
                },
              };
            }

            let attachment;
            try {
              if (request.file.size > MAX_DIRECT_FILE_BYTES) {
                const pending = await getPendingTransfer(request.messageId);
                if (!pending || pending.blob.size !== request.file.size) {
                  throw new Error(
                    "The original large file is no longer available. Select it again.",
                  );
                }
                if (cancelledFileUploads.has(request.messageId)) {
                  throw new DOMException("Upload cancelled", "AbortError");
                }
                const controller = new AbortController();
                activeFileUploads.set(request.messageId, controller);
                try {
                  attachment = await uploadLargeFile({
                    ...request.file,
                    blob: pending.blob,
                    messageId: request.messageId,
                    createdAt: request.createdAt,
                    signal: controller.signal,
                    onProgress: (
                      uploadedBytes,
                      totalBytes,
                      segmentEndBytes,
                      averageUploadBytesPerSecond,
                    ) => {
                      void browser.runtime
                        .sendMessage({
                          type: "files/progress",
                          messageId: request.messageId,
                          uploadedBytes,
                          segmentEndBytes,
                          totalBytes,
                          ...(averageUploadBytesPerSecond
                            ? { averageUploadBytesPerSecond }
                            : {}),
                        })
                        .catch(() => undefined);
                    },
                    ...(request.reuseExisting ? { reuseExisting: true } : {}),
                  });
                } finally {
                  activeFileUploads.delete(request.messageId);
                  cancelledFileUploads.delete(request.messageId);
                }
              } else {
                if (!request.file.base64) {
                  throw new Error("The selected file content is unavailable.");
                }
                attachment = await uploadSmallFile({
                  ...request.file,
                  base64: request.file.base64,
                  messageId: request.messageId,
                  createdAt: request.createdAt,
                  ...(request.reuseExisting ? { reuseExisting: true } : {}),
                });
              }
            } catch (error) {
              try {
                await enqueueMonthWrite(() =>
                  removeMessage(getUtcMonth(), request.messageId),
                );
              } catch {
                // Retry cleanup when the originating device reconnects.
              }
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "upload-failed",
                  error: getErrorMessage(error),
                },
              };
            }

            try {
              const message = createFileMessage(
                attachment,
                deviceId,
                registeredAt,
                request.messageId,
              );
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "sent",
                  result: await enqueueMonthWrite(() =>
                    replaceMessage(getUtcMonth(), message),
                  ),
                },
              };
            } catch (error) {
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "reconciling",
                  error: getErrorMessage(error),
                  attachment,
                  createdAt: registeredAt.toISOString(),
                },
              };
            }
          }
          case "files/cancel":
            cancelledFileUploads.add(request.messageId);
            activeFileUploads.get(request.messageId)?.abort();
            return { ok: true, type: "files/cancelled" };
          case "files/discard-placeholder":
            await enqueueMonthWrite(() =>
              removeMessage(getUtcMonth(), request.messageId),
            );
            return { ok: true, type: "files/placeholder-discarded" };
          case "files/retry-commit": {
            try {
              const message = createFileMessage(
                request.attachment,
                await getOrCreateDeviceId(),
                new Date(request.createdAt),
                request.messageId,
              );
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "sent",
                  result: await enqueueMonthWrite(() =>
                    replaceMessage(getUtcMonth(), message),
                  ),
                },
              };
            } catch (error) {
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "reconciling",
                  error: getErrorMessage(error),
                  attachment: request.attachment,
                  createdAt: request.createdAt,
                },
              };
            }
          }
          case "files/read-preview":
            return {
              ok: true,
              type: "files/preview",
              dataUrl: await readImagePreview(
                request.driveItemId,
                request.mimeType,
              ),
            };
          case "files/check-attachment":
            return {
              ok: true,
              type: "files/availability",
              exists: await checkAttachmentExists(request.driveItemId),
            };
          case "files/check-cleanup":
            return {
              ok: true,
              type: "files/cleanup-checked",
              cleaned: await checkAttachmentCleanup(),
            };
          case "deleted-data/clean-now": {
            const result = await cleanDeletedDataNow();
            return {
              ok: true,
              type: "deleted-data/cleaned",
              ...result,
            };
          }
          case "files/open-local":
            return {
              ok: true,
              type: "files/local-action",
              ...(await openOrDownloadAttachment(
                request.attachment,
                false,
                request.forceDownload,
              )),
            };
          case "files/save-as":
            return {
              ok: true,
              type: "files/local-action",
              ...(await openOrDownloadAttachment(request.attachment, true)),
            };
          case "files/open-in-onedrive":
            await browser.tabs.create({
              url: await getAttachmentWebUrl(request.driveItemId),
            });
            return { ok: true, type: "files/onedrive-opened" };
          case "files/show-in-folder": {
            await browser.downloads.show(request.downloadId);
            const [download] = await browser.downloads.search({
              id: request.downloadId,
            });
            return {
              ok: true,
              type: "files/folder-shown",
              exists:
                Boolean(download) &&
                download?.exists !== false &&
                download?.state !== "interrupted",
            };
          }
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown auth error",
        };
      }
    },
  );
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown file transfer error";
}
