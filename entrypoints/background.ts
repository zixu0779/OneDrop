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
import { readMonthDocument } from "../src/infrastructure/onedrive/month-reader";
import { appendTextMessage } from "../src/infrastructure/onedrive/month-writer";
import { getOrCreateDeviceId } from "../src/features/device/device-service";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "../src/features/messages/create-file-message";
import {
  checkAttachmentExists,
  readImagePreview,
  uploadSmallFile,
} from "../src/infrastructure/onedrive/file-uploader";
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
          case "auth/sign-in":
            return { ok: true, type: "auth/status", status: await signIn() };
          case "auth/sign-out":
            return { ok: true, type: "auth/status", status: await signOut() };
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
            await rebuildTestData();
            return { ok: true, type: "dev/test-data-rebuilt" };
          case "onedrive/verify-app-folder":
            return {
              ok: true,
              type: "onedrive/app-folder",
              appFolder: await verifyAppFolder(),
            };
          case "messages/read-current-month":
            return {
              ok: true,
              type: "messages/month",
              result: await readMonthDocument(getUtcMonth()),
            };
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
            return {
              ok: true,
              type: "messages/conflict-resolved",
              result: await resolveMessageConflict(
                getUtcMonth(),
                request.messageId,
                request.keepItemId,
              ),
            };
          case "messages/send-text": {
            const message = createTextMessage(
              request.text,
              request.createdAt ? new Date(request.createdAt) : new Date(),
              request.messageId ?? crypto.randomUUID(),
              await getOrCreateDeviceId(),
            );
            return {
              ok: true,
              type: "messages/month",
              result: await appendTextMessage(getUtcMonth(), message),
            };
          }
          case "files/send": {
            const deviceId = await getOrCreateDeviceId();
            const registeredAt = new Date(request.createdAt);
            const placeholder = createUploadingFileMessage(
              request.file,
              deviceId,
              registeredAt,
              request.messageId,
            );
            try {
              await appendMessage(getUtcMonth(), placeholder);
            } catch (error) {
              try {
                await removeMessage(getUtcMonth(), request.messageId);
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
              attachment = await uploadSmallFile({
                ...request.file,
                messageId: request.messageId,
                createdAt: request.createdAt,
                ...(request.reuseExisting ? { reuseExisting: true } : {}),
              });
            } catch (error) {
              try {
                await removeMessage(getUtcMonth(), request.messageId);
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
                  result: await replaceMessage(getUtcMonth(), message),
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
          case "files/discard-placeholder":
            await removeMessage(getUtcMonth(), request.messageId);
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
                  result: await replaceMessage(getUtcMonth(), message),
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
