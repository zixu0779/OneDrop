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
import { createFileMessage } from "../src/features/messages/create-file-message";
import {
  checkAttachmentExists,
  readImagePreview,
  uploadSmallFile,
} from "../src/infrastructure/onedrive/file-uploader";
import { appendMessage } from "../src/infrastructure/onedrive/month-writer";
import { openOrDownloadAttachment } from "../src/features/downloads/download-service";

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
          case "messages/send-text": {
            const message = createTextMessage(
              request.text,
              new Date(),
              crypto.randomUUID(),
              await getOrCreateDeviceId(),
            );
            return {
              ok: true,
              type: "messages/month",
              result: await appendTextMessage(getUtcMonth(), message),
            };
          }
          case "files/send": {
            let attachment;
            try {
              attachment = await uploadSmallFile({
                ...request.file,
                messageId: request.messageId,
                createdAt: request.createdAt,
                ...(request.reuseExisting ? { reuseExisting: true } : {}),
              });
            } catch (error) {
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "upload-failed",
                  error: getErrorMessage(error),
                },
              };
            }

            const uploadedAt = new Date();
            try {
              const message = createFileMessage(
                attachment,
                await getOrCreateDeviceId(),
                uploadedAt,
                request.messageId,
              );
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "sent",
                  result: await appendMessage(getUtcMonth(), message),
                },
              };
            } catch (error) {
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "commit-failed",
                  error: getErrorMessage(error),
                  attachment,
                  createdAt: uploadedAt.toISOString(),
                },
              };
            }
          }
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
                  result: await appendMessage(getUtcMonth(), message),
                },
              };
            } catch (error) {
              return {
                ok: true,
                type: "files/transfer",
                transfer: {
                  state: "commit-failed",
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
              action: await openOrDownloadAttachment(request.attachment, false),
            };
          case "files/save-as":
            return {
              ok: true,
              type: "files/local-action",
              action: await openOrDownloadAttachment(request.attachment, true),
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
