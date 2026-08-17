import type {
  AuthStatus,
  MonthReadResult,
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import { getUtcMonth } from "@onedrop/core/features/messages/month";
import { getPendingTransfer } from "@onedrop/web-storage/infrastructure/indexed-db/pending-transfers";
import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import {
  checkAttachmentExistsWithAccessToken,
  getAttachmentWebUrlWithAccessToken,
  readImagePreviewWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/file-uploader";
import {
  readHistoricalMonthDocumentWithAccessToken,
  readMonthDocumentWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import {
  removeMessageWithAccessToken,
  resolveMessageConflictWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/month-writer";
import {
  checkArchiveTasks,
  dismissArchiveNotice,
  resumeArchiveTasksAfterSignIn,
  retryArchiveTask,
} from "@onedrop/onedrive/infrastructure/onedrive/archive-scheduler";
import {
  checkAttachmentCleanup,
  cleanDeletedDataNow,
  resetAttachmentCleanup,
} from "@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup";
import {
  readDeletedMessages,
  restoreDeletedMessage,
} from "@onedrop/onedrive/infrastructure/onedrive/recycle-bin";
import {
  deleteCorruptMonthFileWithAccessToken,
  getCorruptMonthFileFolderUrlWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/corrupt-month-file";
import { verifyAppFolderWithAccessToken } from "@onedrop/onedrive/infrastructure/onedrive/app-folder";
import {
  copyDevicePreferencesWithAccessToken,
  readSettingsWithAccessToken,
  resetDevicePreferences,
  saveAccountSettingsWithAccessToken,
  saveDeviceSettingsWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/settings";
import { setOneDriveRuntime } from "@onedrop/platform/platform/onedrive-runtime";
import type {
  PlatformBridge,
  PlatformDownload,
  PlatformRuntimeEvent,
} from "@onedrop/platform/platform/platform-bridge";
import {
  commitIosFileMessage,
  deleteIosMessage,
  getIosAttachmentDownloadUrl,
  registerIosFileMessage,
  sendIosTextMessage,
  uploadIosFile,
} from "./onedrive";
import {
  getNativeAuthConfiguration,
  nativeAuth,
  type NativeAuthStatus,
} from "./native-auth";
import { nativeDownload } from "./native-download";
import {
  iosDownloadId,
  iosImageMetadata,
  iosTimelineResult,
} from "./platform-values";
import { appMetadata } from "@onedrop/core/config/app";

const DEVICE_ID_KEY = "onedrop-ios-device-id";
const DOWNLOAD_MAP_PREFIX = "onedrop.ios.download-map.";
const listeners = new Set<(event: PlatformRuntimeEvent) => void>();
const uploads = new Map<string, AbortController>();

setOneDriveRuntime({
  async getAccessToken() {
    return (await nativeAuth.getAccessToken()).accessToken;
  },
  storage: {
    async get(key) {
      const value = localStorage.getItem(key);
      return value === null ? undefined : JSON.parse(value);
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      localStorage.removeItem(key);
    },
  },
  async emit(message) {
    for (const listener of listeners) {
      listener(message as PlatformRuntimeEvent);
    }
  },
});

void nativeDownload.addListener("progress", (progress) => {
  emit({ type: "files/download-progress", ...progress });
});

export const iosPlatformBridge: PlatformBridge = {
  capabilities: {
    showInFolder: true,
    saveAs: true,
    navigationDownload: false,
  },

  appVersion() {
    return appMetadata.version;
  },

  async request(request) {
    try {
      return await handleRequest(request);
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async findDownload(downloadId) {
    const driveItemId = localStorage.getItem(
      `${DOWNLOAD_MAP_PREFIX}${downloadId}`,
    );
    return driveItemId
      ? nativeDownloadStatus(driveItemId, downloadId)
      : undefined;
  },

  async findAttachmentDownload(driveItemId) {
    const downloadId = rememberDownload(driveItemId);
    return nativeDownloadStatus(driveItemId, downloadId);
  },

  async openDownload(downloadId) {
    const driveItemId = localStorage.getItem(
      `${DOWNLOAD_MAP_PREFIX}${downloadId}`,
    );
    if (!driveItemId) {
      throw new Error(
        "The local file no longer exists. Please download it again.",
      );
    }
    await nativeDownload.open({ driveItemId });
  },

  async copyText(text) {
    await nativeDownload.copyText({ text });
  },

  async copyImage(dataUrl) {
    await nativeDownload.copyImage({ dataUrl });
  },
};

async function handleRequest(
  request: RuntimeRequest,
): Promise<RuntimeResponse> {
  switch (request.type) {
    case "auth/status":
      return authResponse(await nativeAuth.status());
    case "auth/sign-in": {
      const configuration = getNativeAuthConfiguration();
      if (!configuration.clientId) {
        throw new Error("Microsoft authentication is not configured.");
      }
      const status = await nativeAuth.signIn(configuration);
      if (status.state === "signed-in") await resumeArchiveTasksAfterSignIn();
      return authResponse(status);
    }
    case "auth/sign-out": {
      const status = await nativeAuth.signOut();
      await resetAttachmentCleanup();
      return authResponse(status);
    }
    case "device/id":
      return { ok: true, type: "device/id", deviceId: deviceId() };
    case "settings/read": {
      const token = await accessToken();
      return {
        ok: true,
        type: "settings/snapshot",
        snapshot: await readSettingsWithAccessToken(
          token,
          deviceId(),
          request.platform,
          request.deviceName,
        ),
      };
    }
    case "settings/save-account":
      return {
        ok: true,
        type: "settings/account",
        account: await saveAccountSettingsWithAccessToken(
          await accessToken(),
          request.account,
        ),
      };
    case "settings/save-device":
      return {
        ok: true,
        type: "settings/device",
        device: await saveDeviceSettingsWithAccessToken(
          await accessToken(),
          request.device,
        ),
      };
    case "settings/copy-device": {
      const token = await accessToken();
      const snapshot = await readSettingsWithAccessToken(
        token,
        deviceId(),
        request.platform,
      );
      return {
        ok: true,
        type: "settings/device",
        device: await copyDevicePreferencesWithAccessToken(
          token,
          snapshot.device,
          request.sourceDeviceId,
        ),
      };
    }
    case "settings/reset-device": {
      const token = await accessToken();
      const snapshot = await readSettingsWithAccessToken(
        token,
        deviceId(),
        request.platform,
      );
      return {
        ok: true,
        type: "settings/device",
        device: await saveDeviceSettingsWithAccessToken(
          token,
          resetDevicePreferences(snapshot.device),
        ),
      };
    }
    case "app/open-project":
      await nativeDownload.openExternal({ url: appMetadata.repositoryUrl });
      return { ok: true, type: "app/project-opened" };
    case "onedrive/verify-app-folder":
      return {
        ok: true,
        type: "onedrive/app-folder",
        appFolder: await verifyAppFolderWithAccessToken(await accessToken()),
      };
    case "onedrive/open-app-folder": {
      const folder = await verifyAppFolderWithAccessToken(await accessToken());
      if (!folder.webUrl)
        throw new Error("OneDrive did not provide the folder link.");
      await nativeDownload.openExternal({ url: folder.webUrl });
      return { ok: true, type: "onedrive/app-folder-opened" };
    }
    case "messages/read-current-month":
      return monthResponse(
        await readMonthDocumentWithAccessToken(
          getUtcMonth(),
          await accessToken(),
        ),
      );
    case "messages/read-month":
      return monthResponse(
        await readHistoricalMonthDocumentWithAccessToken(
          request.month,
          await accessToken(),
        ),
      );
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
      await deleteIosMessage(request.month, request.messageId);
      void checkAttachmentCleanup(new Date(), true).catch(() => undefined);
      return {
        ok: true,
        type: "messages/deleted",
        result:
          request.month === getUtcMonth()
            ? await readMonthDocumentWithAccessToken(
                request.month,
                await accessToken(),
              )
            : await readHistoricalMonthDocumentWithAccessToken(
                request.month,
                await accessToken(),
              ),
      };
    case "messages/delete-corrupt-file":
      await deleteCorruptMonthFileWithAccessToken(
        request.itemId,
        await accessToken(),
      );
      await deleteMonthCache(getUtcMonth());
      return { ok: true, type: "messages/corrupt-file-deleted" };
    case "messages/open-corrupt-file-location":
      await nativeDownload.openExternal({
        url: await getCorruptMonthFileFolderUrlWithAccessToken(
          request.itemId,
          await accessToken(),
        ),
      });
      return { ok: true, type: "messages/corrupt-file-location-opened" };
    case "messages/resolve-conflict":
      return {
        ok: true,
        type: "messages/conflict-resolved",
        result: await resolveMessageConflictWithAccessToken(
          getUtcMonth(),
          request.messageId,
          request.keepItemId,
          await accessToken(),
        ),
      };
    case "messages/send-text":
      return monthResponse(
        iosTimelineResult(
          await sendIosTextMessage({
            id: request.messageId ?? crypto.randomUUID(),
            text: request.text,
            createdAt: request.createdAt ?? new Date().toISOString(),
            senderDeviceId: deviceId(),
          }),
        ),
      );
    case "files/send":
      return sendFile(request);
    case "files/cancel":
      uploads.get(request.messageId)?.abort();
      uploads.delete(request.messageId);
      return { ok: true, type: "files/cancelled" };
    case "files/discard-placeholder":
      await removeMessageWithAccessToken(
        getUtcMonth(),
        request.messageId,
        await accessToken(),
      );
      return { ok: true, type: "files/placeholder-discarded" };
    case "files/retry-commit":
      return {
        ok: true,
        type: "files/transfer",
        transfer: {
          state: "sent",
          result: iosTimelineResult(
            await commitIosFileMessage({
              id: request.messageId,
              attachment: request.attachment,
              createdAt: request.createdAt,
              senderDeviceId: deviceId(),
            }),
          ),
        },
      };
    case "files/read-preview":
      return {
        ok: true,
        type: "files/preview",
        dataUrl: await readImagePreviewWithAccessToken(
          request.driveItemId,
          request.mimeType,
          await accessToken(),
        ),
      };
    case "files/check-attachment":
      return {
        ok: true,
        type: "files/availability",
        exists: await checkAttachmentExistsWithAccessToken(
          request.driveItemId,
          await accessToken(),
        ),
      };
    case "files/check-cleanup":
      return {
        ok: true,
        type: "files/cleanup-checked",
        cleaned: await checkAttachmentCleanup(),
      };
    case "files/get-download-url":
      return {
        ok: true,
        type: "files/download-url",
        url: await getIosAttachmentDownloadUrl(request.driveItemId),
      };
    case "files/prepare-mobile-download":
    case "files/mobile-download-status":
      return { ok: true, type: "files/mobile-download" };
    case "files/cancel-mobile-download":
      await nativeDownload.cancel({ driveItemId: request.driveItemId });
      return { ok: true, type: "files/mobile-download-cleared" };
    case "files/clear-mobile-download":
      return { ok: true, type: "files/mobile-download-cleared" };
    case "deleted-data/clean-now": {
      const result = await cleanDeletedDataNow();
      return { ok: true, type: "deleted-data/cleaned", ...result };
    }
    case "deleted-data/read":
      return {
        ok: true,
        type: "deleted-data/items",
        items: await readDeletedMessages(),
      };
    case "deleted-data/restore": {
      const item = await restoreDeletedMessage(
        request.month,
        request.messageId,
      );
      return {
        ok: true,
        type: "deleted-data/restored",
        item,
        result:
          request.month === getUtcMonth()
            ? await readMonthDocumentWithAccessToken(
                request.month,
                await accessToken(),
              )
            : await readHistoricalMonthDocumentWithAccessToken(
                request.month,
                await accessToken(),
              ),
      };
    }
    case "files/open-local": {
      const downloadId = await ensureDownloaded(request.attachment);
      return {
        ok: true,
        type: "files/local-action",
        action: "downloaded",
        downloadId,
      };
    }
    case "files/save-as": {
      const downloadId = await ensureDownloaded(request.attachment);
      await nativeDownload.export({
        driveItemId: request.attachment.driveItemId,
      });
      return {
        ok: true,
        type: "files/local-action",
        action: "downloaded",
        downloadId,
      };
    }
    case "files/open-in-onedrive":
      await nativeDownload.openExternal({
        url: await getAttachmentWebUrlWithAccessToken(
          request.driveItemId,
          await accessToken(),
        ),
      });
      return { ok: true, type: "files/onedrive-opened" };
    case "files/show-in-folder": {
      const driveItemId = downloadIdToDriveItemId(request.downloadId);
      if (!driveItemId) {
        return { ok: true, type: "files/folder-shown", exists: false };
      }
      const status = await nativeDownload.status({ driveItemId });
      if (!status.exists) {
        return { ok: true, type: "files/folder-shown", exists: false };
      }
      await nativeDownload.showInFolder({ driveItemId });
      return { ok: true, type: "files/folder-shown", exists: true };
    }
  }
}

async function sendFile(
  request: Extract<RuntimeRequest, { type: "files/send" }>,
): Promise<RuntimeResponse> {
  try {
    await registerIosFileMessage({
      id: request.messageId,
      ...request.file,
      createdAt: request.createdAt,
      senderDeviceId: deviceId(),
    });
    const pending = await getPendingTransfer(request.messageId);
    const file =
      pending?.blob ?? decodeBase64(request.file.base64, request.file.mimeType);
    if (!file) throw new Error("The original file is no longer available.");
    const controller = new AbortController();
    uploads.set(request.messageId, controller);
    const attachment = await uploadIosFile({
      id: request.messageId,
      file,
      name: request.file.name,
      mimeType: request.file.mimeType,
      createdAt: request.createdAt,
      ...iosImageMetadata(request.file),
      signal: controller.signal,
      onProgress(
        uploadedBytes,
        totalBytes,
        segmentEndBytes,
        averageUploadBytesPerSecond,
      ) {
        emit({
          type: "files/progress",
          messageId: request.messageId,
          uploadedBytes,
          segmentEndBytes,
          totalBytes,
          ...(averageUploadBytesPerSecond
            ? { averageUploadBytesPerSecond }
            : {}),
        });
      },
    });
    const result = iosTimelineResult(
      await commitIosFileMessage({
        id: request.messageId,
        attachment,
        createdAt: request.createdAt,
        senderDeviceId: deviceId(),
      }),
    );
    return {
      ok: true,
      type: "files/transfer",
      transfer: { state: "sent", result },
    };
  } catch (cause) {
    return {
      ok: true,
      type: "files/transfer",
      transfer: {
        state: "upload-failed",
        error: cause instanceof Error ? cause.message : String(cause),
      },
    };
  } finally {
    uploads.delete(request.messageId);
  }
}

async function ensureDownloaded(attachment: {
  driveItemId: string;
  name: string;
}): Promise<number> {
  const status = await nativeDownload.status({
    driveItemId: attachment.driveItemId,
  });
  if (!status.exists) {
    await nativeDownload.download({
      url: await getIosAttachmentDownloadUrl(attachment.driveItemId),
      driveItemId: attachment.driveItemId,
      fileName: attachment.name,
    });
  }
  return rememberDownload(attachment.driveItemId);
}

async function nativeDownloadStatus(
  driveItemId: string,
  downloadId: number,
): Promise<PlatformDownload | undefined> {
  const status = await nativeDownload.status({ driveItemId });
  if (!status.exists && !status.downloading) return undefined;
  return {
    id: downloadId,
    state: status.exists ? "complete" : "in_progress",
    exists: status.exists,
    ...(status.fileName ? { filename: status.fileName } : {}),
  };
}

function rememberDownload(driveItemId: string): number {
  const id = iosDownloadId(driveItemId);
  localStorage.setItem(`${DOWNLOAD_MAP_PREFIX}${id}`, driveItemId);
  return id;
}

function downloadIdToDriveItemId(downloadId: number): string | null {
  return localStorage.getItem(`${DOWNLOAD_MAP_PREFIX}${downloadId}`);
}

function decodeBase64(
  value: string | undefined,
  mimeType: string,
): Blob | undefined {
  if (!value) return undefined;
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

function monthResponse(result: MonthReadResult): RuntimeResponse {
  return { ok: true, type: "messages/month", result };
}

function authResponse(status: NativeAuthStatus): RuntimeResponse {
  const normalized: AuthStatus =
    status.state === "signed-in"
      ? {
          state: "signed-in",
          redirectUri: status.redirectUri,
          account: status.account ?? {},
          expiresAt: status.expiresAt ?? new Date().toISOString(),
        }
      : { state: "signed-out", redirectUri: status.redirectUri };
  return { ok: true, type: "auth/status", status: normalized };
}

async function accessToken(): Promise<string> {
  return (await nativeAuth.getAccessToken()).accessToken;
}

function deviceId(): string {
  let value = localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

function emit(event: PlatformRuntimeEvent): void {
  for (const listener of listeners) listener(event);
}
