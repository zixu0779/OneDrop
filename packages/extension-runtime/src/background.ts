import { compareVersions } from "@onedrop/core/domain/app-update";
import {
  readAccountAvatarWithAccessToken,
  saveAccountAvatarWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/settings";
import { pauseAccountTransfers } from "@onedrop/web-storage/infrastructure/indexed-db/account-data";
import { accountStorageScope } from "@onedrop/core/domain/local-account";
import {
  configureAccountContext,
  currentAccountScope,
} from "@onedrop/app-runtime/features/auth/account-context";
import {
  configureExtensionDatabase,
  oneDropDatabase,
} from "@onedrop/web-storage/infrastructure/indexed-db/database";
import { pauseArchiveTasks } from "@onedrop/onedrive/infrastructure/onedrive/archive-scheduler";
import { pauseAttachmentCleanup } from "@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup";
import type {
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import {
  hasPendingAuthorizationCallback,
  resumePendingTabAuthorization,
  listAccounts,
  switchAccount,
  removeAccount,
  getCurrentAccessToken,
  getAuthStatus,
  signIn,
  signOut,
} from "@onedrop/app-runtime/features/auth/auth-service";
import {
  copyDevicePreferencesWithAccessToken,
  deleteDeviceSettingsWithAccessToken,
  readAccountSettingsWithAccessToken,
  readSettingsWithAccessToken,
  resetDevicePreferences,
  saveAccountSettingsWithAccessToken,
  saveDeviceSettingsWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/settings";
import { verifyAppFolder } from "@onedrop/onedrive/infrastructure/onedrive/app-folder";
import { createTextMessage } from "@onedrop/core/features/messages/create-text-message";
import { listHistoryMonths } from "@onedrop/onedrive/infrastructure/onedrive/month-list";
import { getUtcMonth } from "@onedrop/core/features/messages/month";
import {
  readHistoricalMonthDocument,
  readMonthDocument,
} from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import { appendTextMessage } from "@onedrop/onedrive/infrastructure/onedrive/month-writer";
import { getOrCreateDeviceId } from "@onedrop/app-runtime/features/device/device-service";
import { appMetadata } from "@onedrop/core/config/app";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "@onedrop/core/features/messages/create-file-message";
import {
  checkAttachmentExists,
  getAttachmentDownloadUrl,
  getAttachmentWebUrl,
  readImagePreview,
  uploadLargeFile,
  uploadSmallFile,
} from "@onedrop/onedrive/infrastructure/onedrive/file-uploader";
import { shouldUseUploadSession } from "@onedrop/core/config/files";
import { getPendingTransfer } from "@onedrop/web-storage/infrastructure/indexed-db/pending-transfers";
import {
  appendMessage,
  removeMessage,
  resolveMessageConflict,
  replaceMessage,
} from "@onedrop/onedrive/infrastructure/onedrive/month-writer";
import { openOrDownloadAttachment } from "@onedrop/app-runtime/features/downloads/download-service";
import {
  deleteCorruptMonthFile,
  getCorruptMonthFileFolderUrl,
} from "@onedrop/onedrive/infrastructure/onedrive/corrupt-month-file";
import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import { writeMessageTombstoneWithAccessToken } from "@onedrop/onedrive/infrastructure/onedrive/tombstones";
import {
  checkArchiveTasks,
  dismissArchiveNotice,
  retryArchiveTask,
} from "@onedrop/onedrive/infrastructure/onedrive/archive-scheduler";
import {
  cleanDeletedDataNow,
  checkAttachmentCleanup,
} from "@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup";
import {
  readDeletedMessages,
  restoreDeletedMessage,
} from "@onedrop/onedrive/infrastructure/onedrive/recycle-bin";
import { enqueueMonthWrite } from "@onedrop/onedrive/infrastructure/onedrive/month-write-coordinator";
import { enqueueTombstoneWrite } from "@onedrop/onedrive/infrastructure/onedrive/tombstone-write-coordinator";
import {
  cancelMobileNavigationDownload,
  claimMobileNavigationDownload,
  clearMobileNavigationDownload,
  prepareMobileNavigationDownload,
  readMobileNavigationDownloadStatus,
} from "@onedrop/app-runtime/features/downloads/mobile-navigation-download";
import {
  detectEdgeRuntimePlatform,
  type EdgeRuntimePlatform,
} from "./edge-platform";

const activeFileUploads = new Map<string, AbortController>();
const cancelledFileUploads = new Set<string>();

export default defineBackground(() => {
  const runtimePlatform = readRuntimePlatform();

  if (browser.downloads?.onCreated) {
    browser.downloads.onCreated.addListener((item) => {
      void claimMobileNavigationDownload(item).catch(() => undefined);
    });
  }
  browser.action.onClicked.addListener(() => {
    void runtimePlatform.then(async (platform) => {
      if (platform !== "android") return;
      try {
        await openOrFocusMobilePage("/android-mobile.html");
      } catch (error: unknown) {
        console.error("OneDrop mobile page could not be opened.", error);
        await browser.action.setBadgeBackgroundColor({ color: "#d93025" });
        await browser.action.setBadgeText({ text: "!" });
      }
    });
  });

  void configureExtensionAction(runtimePlatform);

  browser.runtime.onInstalled.addListener(() => {
    void configureExtensionAction(runtimePlatform);
  });

  let updateViewRevision = 0;
  const updateViews = new Set<ReturnType<typeof browser.runtime.connect>>();
  browser.runtime.onConnect?.addListener((port) => {
    if (port.name !== "onedrop-updates") return;
    updateViewRevision++;
    updateViews.add(port);
    port.onDisconnect.addListener(() => updateViews.delete(port));
  });
  async function lockUpdateViews(): Promise<void> {
    if (!updateViews.size)
      throw new Error("The OneDrop window is not ready. Try Install again.");
    const results = await Promise.allSettled(
      [...updateViews].map(
        (port) =>
          new Promise<void>((resolve, reject) => {
            const id = crypto.randomUUID();
            const onMessage = (message: { id?: string; idle?: boolean }) => {
              if (message.id !== id) return;
              clearTimeout(timer);
              port.onMessage.removeListener(onMessage);
              if (message.idle) resolve();
              else
                reject(
                  new Error(
                    "Wait for current work to finish, then try Install again.",
                  ),
                );
            };
            const timer = setTimeout(() => {
              port.onMessage.removeListener(onMessage);
              reject(
                new Error(
                  "Another OneDrop window is not ready. Close it and try again.",
                ),
              );
            }, 3000);
            port.onMessage.addListener(onMessage);
            try {
              port.postMessage({ type: "lock", id });
            } catch (error) {
              clearTimeout(timer);
              port.onMessage.removeListener(onMessage);
              reject(error);
            }
          }),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  let preparedUpdate: string | undefined;
  browser.runtime.onUpdateAvailable?.addListener(({ version }) => {
    preparedUpdate = version;
    void browser.storage.local.set({ "onedrop.prepared-update": version });
  });
  const pendingRequests = new Set<Promise<RuntimeResponse>>();
  let changingAccount = false;
  let installingUpdate = false;
  let managementLocked = false;
  let databaseReady = false;
  async function selectDatabase() {
    const { activeKey } = await listAccounts();
    const scope = activeKey
      ? await accountStorageScope(activeKey)
      : "signed-out";
    if (scope !== currentAccountScope() || !databaseReady) {
      configureAccountContext(scope);
      configureExtensionDatabase(scope);
      databaseReady = true;
    }
    return scope;
  }
  const ready = resumePendingTabAuthorization()
    .catch(() => undefined)
    .then(selectDatabase);
  browser.runtime.onMessage.addListener(
    async (
      request:
        | (RuntimeRequest & { accountScope?: string })
        | { type: "updates/check" }
        | { type: "updates/install" },
    ) => {
      // Runtime progress events are broadcasts, not commands.
      if (!request.type || request.type.endsWith("progress")) return;
      if (
        request.type === "updates/check" ||
        request.type === "updates/install"
      ) {
        try {
          const manifest = browser.runtime.getManifest();
          if (
            !manifest.update_url ||
            new URL(manifest.update_url).hostname !== "edge.microsoft.com"
          )
            throw new Error(
              "Store update checks are unavailable for this installation.",
            );
          const cached = (
            await browser.storage.local.get("onedrop.prepared-update")
          )["onedrop.prepared-update"];
          if (
            typeof cached === "string" &&
            compareVersions(cached, manifest.version) > 0
          )
            preparedUpdate = cached;
          if (request.type === "updates/check") {
            const checked = await browser.runtime.requestUpdateCheck();
            if (checked.status === "update_available" && checked.version) {
              preparedUpdate = checked.version;
              await browser.storage.local.set({
                "onedrop.prepared-update": checked.version,
              });
            }
            if (
              preparedUpdate &&
              compareVersions(preparedUpdate, manifest.version) > 0
            )
              return {
                ok: true,
                result: { state: "available", version: preparedUpdate },
              };
            if (checked.status === "throttled")
              throw new Error(
                "The browser limited update checks. Try again later.",
              );
            if (checked.status !== "no_update")
              throw new Error("The browser could not check for updates.");
            return { ok: true, result: { state: "current" } };
          }
          await ready;
          if (
            !preparedUpdate ||
            compareVersions(preparedUpdate, manifest.version) <= 0
          )
            throw new Error(
              "No browser update is ready to install. Check again.",
            );
          if (
            managementLocked ||
            changingAccount ||
            pendingRequests.size ||
            activeFileUploads.size
          )
            throw new Error(
              "Wait for current work to finish, then try Install again.",
            );
          managementLocked = true;
          changingAccount = true;
          installingUpdate = true;
          try {
            const views = updateViewRevision;
            await lockUpdateViews();
            const [texts, files] = await Promise.all([
              oneDropDatabase.pendingTexts.toArray(),
              oneDropDatabase.pendingTransfers.toArray(),
            ]);
            if (
              texts.some((item) => item.status === "sending") ||
              files.some(
                (item) =>
                  item.status === "uploading" || item.status === "committing",
              )
            )
              throw new Error(
                "Wait for current work to finish, then try Install again.",
              );
            const drains = await Promise.allSettled([
              pauseArchiveTasks(),
              pauseAttachmentCleanup(),
            ]);
            const failedDrain = drains.find(
              (result) => result.status === "rejected",
            );
            if (failedDrain?.status === "rejected") throw failedDrain.reason;
            if (views !== updateViewRevision)
              throw new Error(
                "Another OneDrop window opened. Try Install again.",
              );
            browser.runtime.reload();
            return { ok: true };
          } finally {
            for (const port of updateViews) {
              try {
                port.postMessage({ type: "unlock" });
              } catch {
                /* closed view */
              }
            }
            managementLocked = false;
            changingAccount = false;
            installingUpdate = false;
          }
        } catch (cause) {
          return {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }
      await ready;
      if (request.type === "accounts/list")
        return {
          ok: true,
          type: "accounts/list",
          accounts: await listAccounts(),
        };
      const management =
        [
          "accounts/add",
          "accounts/switch",
          "accounts/remove",
          "auth/sign-in",
          "auth/sign-out",
        ].includes(request.type) ||
        (request.type === "auth/status" &&
          (await hasPendingAuthorizationCallback()));
      if (changingAccount || request.accountScope !== currentAccountScope())
        return {
          ok: false,
          error: installingUpdate
            ? "An update is being installed. Try again after it finishes."
            : "The active account changed. Reopen OneDrop to continue.",
          accountPaused:
            !installingUpdate &&
            (request.type === "messages/send-text" ||
              request.type === "files/send"),
        };
      if (management) {
        if (managementLocked)
          return {
            ok: false,
            error: "An account change is already in progress.",
          };
        managementLocked = true;
        try {
          if (request.type === "accounts/remove") {
            const result = await handleRequest(request);
            await browser.runtime
              .sendMessage({ type: "accounts/updated" })
              .catch(() => undefined);
            return result;
          }
          changingAccount = true;
          await pauseAccountTransfers([...activeFileUploads.keys()]);
          for (const upload of activeFileUploads.values()) upload.abort();
          await Promise.allSettled([...pendingRequests]);
          await pauseArchiveTasks();
          await pauseAttachmentCleanup();
          const oldScope = currentAccountScope();
          if (request.type === "auth/status")
            await resumePendingTabAuthorization();
          const result = await handleRequest(request);
          const scope = await selectDatabase();
          if (
            result.ok &&
            (scope !== oldScope || request.type !== "auth/status")
          )
            await browser.runtime
              .sendMessage({ type: "accounts/changed", accountScope: scope })
              .catch(() => undefined);
          if (!result.ok) {
            changingAccount = false;
            await browser.runtime
              .sendMessage({ type: "accounts/resume", accountScope: oldScope })
              .catch(() => undefined);
          }
          return result;
        } finally {
          changingAccount = false;
          managementLocked = false;
        }
      }
      const operation = handleRequest(request);
      pendingRequests.add(operation);
      try {
        return await operation;
      } finally {
        pendingRequests.delete(operation);
      }
    },
  );

  async function handleRequest(
    request: RuntimeRequest,
  ): Promise<RuntimeResponse> {
    try {
      switch (request.type) {
        case "accounts/list":
          return {
            ok: true,
            type: "accounts/list",
            accounts: await listAccounts(),
          };
        case "accounts/add":
          await signIn(request.reauthenticateKey);
          return {
            ok: true,
            type: "accounts/list",
            accounts: await listAccounts(),
          };
        case "accounts/switch":
          await switchAccount(request.accountKey);
          return {
            ok: true,
            type: "accounts/list",
            accounts: await listAccounts(),
          };
        case "accounts/remove": {
          if ((await listAccounts()).activeKey === request.accountKey)
            throw new Error("Use Sign out to remove the current account.");
          await removeAccount(request.accountKey);
          return {
            ok: true,
            type: "accounts/list",
            accounts: await listAccounts(),
          };
        }
        case "auth/status":
          return {
            ok: true,
            type: "auth/status",
            status: await getAuthStatus(),
          };
        case "auth/sign-in": {
          const status = await signIn();
          return { ok: true, type: "auth/status", status };
        }
        case "auth/sign-out": {
          const status = await signOut();
          return { ok: true, type: "auth/status", status };
        }
        case "device/id":
          return {
            ok: true,
            type: "device/id",
            deviceId: await getOrCreateDeviceId(),
          };
        case "settings/read-avatar":
          return {
            ok: true,
            type: "settings/avatar",
            avatar: await readAccountAvatarWithAccessToken(
              await getCurrentAccessToken(),
            ),
          };
        case "settings/save-avatar":
          return {
            ok: true,
            type: "settings/avatar",
            avatar: await saveAccountAvatarWithAccessToken(
              await getCurrentAccessToken(),
              request.avatar,
            ),
          };
        case "settings/read": {
          const accessToken = await getCurrentAccessToken();
          const snapshot = await readSettingsWithAccessToken(
            accessToken,
            await getOrCreateDeviceId(),
            request.platform,
            request.deviceName,
          );
          return { ok: true, type: "settings/snapshot", snapshot };
        }
        case "settings/save-account":
          return {
            ok: true,
            type: "settings/account",
            account: await saveAccountSettingsWithAccessToken(
              await getCurrentAccessToken(),
              request.account,
            ),
          };
        case "settings/save-device":
          return {
            ok: true,
            type: "settings/device",
            device: await saveDeviceSettingsWithAccessToken(
              await getCurrentAccessToken(),
              request.device,
            ),
          };
        case "settings/delete-device":
          if (request.deviceId === (await getOrCreateDeviceId())) {
            throw new Error("The current device cannot delete itself.");
          }
          await deleteDeviceSettingsWithAccessToken(
            await getCurrentAccessToken(),
            request.deviceId,
          );
          return {
            ok: true,
            type: "settings/device-deleted",
            deviceId: request.deviceId,
          };
        case "settings/copy-device": {
          const token = await getCurrentAccessToken();
          const snapshot = await readSettingsWithAccessToken(
            token,
            await getOrCreateDeviceId(),
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
          const token = await getCurrentAccessToken();
          const snapshot = await readSettingsWithAccessToken(
            token,
            await getOrCreateDeviceId(),
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
          await browser.tabs.create({ url: appMetadata.repositoryUrl });
          return { ok: true, type: "app/project-opened" };
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
        case "messages/list-months":
          return {
            ok: true,
            type: "messages/months",
            months: await listHistoryMonths(await getCurrentAccessToken()),
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
        case "messages/delete": {
          const token = await getCurrentAccessToken();
          const recycle = (await readAccountSettingsWithAccessToken(token))
            .recycleBin;
          await enqueueTombstoneWrite(() =>
            writeMessageTombstoneWithAccessToken(
              request.month,
              request.messageId,
              token,
              recycle,
            ),
          );
          void checkAttachmentCleanup(new Date(), true).catch(() => undefined);
          return {
            ok: true,
            type: "messages/deleted",
            result:
              request.month === getUtcMonth()
                ? await readMonthDocument(request.month)
                : await readHistoricalMonthDocument(request.month),
          };
        }
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
            if (shouldUseUploadSession(request.file)) {
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
                        accountScope: currentAccountScope(),
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
              if (cancelledFileUploads.has(request.messageId)) {
                throw new DOMException("Upload cancelled", "AbortError");
              }
              const controller = new AbortController();
              activeFileUploads.set(request.messageId, controller);
              try {
                attachment = await uploadSmallFile({
                  ...request.file,
                  base64: request.file.base64,
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
                        accountScope: currentAccountScope(),
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
        case "files/get-download-url":
          return {
            ok: true,
            type: "files/download-url",
            url: await getAttachmentDownloadUrl(request.driveItemId),
          };
        case "files/prepare-mobile-download":
          return {
            ok: true,
            type: "files/mobile-download",
            download: await prepareMobileNavigationDownload(request.attachment),
          };
        case "files/mobile-download-status": {
          const download = await readMobileNavigationDownloadStatus(
            request.driveItemId,
          );
          return {
            ok: true,
            type: "files/mobile-download",
            ...(download ? { download } : {}),
          };
        }
        case "files/cancel-mobile-download":
          await cancelMobileNavigationDownload(request.driveItemId);
          return { ok: true, type: "files/mobile-download-cleared" };
        case "files/clear-mobile-download":
          await clearMobileNavigationDownload(request.driveItemId);
          return { ok: true, type: "files/mobile-download-cleared" };
        case "deleted-data/clean-now": {
          const result = await cleanDeletedDataNow();
          return {
            ok: true,
            type: "deleted-data/cleaned",
            ...result,
          };
        }
        case "deleted-data/read":
          return {
            ok: true,
            type: "deleted-data/items",
            items: await readDeletedMessages(),
          };
        case "deleted-data/restore":
          return enqueueMonthWrite(async () => {
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
                  ? await readMonthDocument(request.month)
                  : await readHistoricalMonthDocument(request.month),
            };
          });
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
  }
});

async function configureExtensionAction(
  platformPromise: Promise<EdgeRuntimePlatform>,
): Promise<void> {
  const platform = await platformPromise;
  await browser.action.setPopup({
    popup: platform === "ios" ? "ios-mobile.html" : "",
  });
  if (platform === "desktop" && browser.sidePanel?.setPanelBehavior) {
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

async function readRuntimePlatform(): Promise<EdgeRuntimePlatform> {
  let operatingSystem: string | undefined;
  try {
    operatingSystem = (await browser.runtime.getPlatformInfo()).os;
  } catch {
    // User-agent detection remains available on mobile extension runtimes.
  }
  return detectEdgeRuntimePlatform(navigator.userAgent, operatingSystem);
}

async function openOrFocusMobilePage(path: "/android-mobile.html") {
  const mobilePageUrl = browser.runtime.getURL(path as never);
  const matchingTabs = await browser.tabs.query({ url: `${mobilePageUrl}*` });
  const existingTab = matchingTabs.find(
    (tab) => tab.id !== undefined && tab.windowId !== undefined,
  );
  if (existingTab?.id !== undefined && existingTab.windowId !== undefined) {
    await browser.windows.update(existingTab.windowId, { focused: true });
    await browser.tabs.update(existingTab.id, { active: true });
    return;
  }
  await browser.tabs.create({ url: mobilePageUrl });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown file transfer error";
}
