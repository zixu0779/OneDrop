import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";

import type {
  AuthStatus,
  MonthReadResult,
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";
import type {
  Attachment,
  Message,
  UploadingFileMessage,
} from "../../src/domain/message";
import { MAX_DIRECT_FILE_BYTES } from "../../src/config/files";
import {
  deletePendingTransfer,
  listPendingTransfers,
  putPendingTransfer,
  updatePendingTransfer,
} from "../../src/infrastructure/indexed-db/pending-transfers";
import {
  deleteDownloadRecord,
  getDownloadRecord,
  markDownloadOpened,
} from "../../src/infrastructure/indexed-db/downloads";
import { getMonthCache } from "../../src/infrastructure/indexed-db/sync-cache";
import { getUtcMonth } from "../../src/features/messages/month";
import {
  deletePendingText,
  listPendingTexts,
  putPendingText,
  updatePendingText,
} from "../../src/infrastructure/indexed-db/pending-texts";

export type PendingFile = {
  id: string;
  createdAt: string;
  file?: File;
  previewUrl?: string;
  isImage: boolean;
  status: "uploading" | "committing" | "upload-failed";
  error?: string;
  attachment?: Attachment;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
};

export type PendingText = {
  id: string;
  createdAt: string;
  text: string;
  status: "sending" | "send-failed";
  error?: string;
};

type ReadyMessage = Exclude<Message, { type: "file-uploading" }>;

async function sendRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  const response = (await browser.runtime.sendMessage(
    request,
  )) as RuntimeResponse;

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response;
}

async function sendAuthRequest(request: RuntimeRequest): Promise<AuthStatus> {
  const response = await sendRequest(request);

  if (!response.ok || response.type !== "auth/status") {
    throw new Error("OneDrop received an unexpected authentication response.");
  }

  return response.status;
}

export function App() {
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);
  const [monthResult, setMonthResult] = useState<MonthReadResult>();
  const [deviceId, setDeviceId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isTimelineScrolling, setIsTimelineScrolling] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingTexts, setPendingTexts] = useState<PendingText[]>([]);
  const [attachmentCheckVersion, setAttachmentCheckVersion] = useState(0);
  const [scrollRevision, setScrollRevision] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const accountCardRef = useRef<HTMLElement>(null);
  const isSendingRef = useRef(false);
  const isTimelineHoveredRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reselectPendingIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    resizeComposer(composerRef.current);
  }, [draft]);

  const timelineIdentity = [
    ...(monthResult?.state === "loaded"
      ? monthResult.messages.map((message) => message.id)
      : []),
    ...pendingFiles.map((pending) => pending.id),
    ...pendingTexts.map((pending) => pending.id),
  ].join("|");

  useLayoutEffect(() => {
    const timeline = timelineScrollRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [timelineIdentity, scrollRevision]);

  useEffect(() => {
    if (!isAccountOpen) return;

    function closeAccount(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountCardRef.current?.contains(event.target)
      ) {
        setIsAccountOpen(false);
      }
    }

    function closeAccountWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setIsAccountOpen(false);
    }

    document.addEventListener("pointerdown", closeAccount);
    document.addEventListener("keydown", closeAccountWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeAccount);
      document.removeEventListener("keydown", closeAccountWithKeyboard);
    };
  }, [isAccountOpen]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const updateVisibility = () =>
      setIsPanelVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const hasUploadingMessages =
    monthResult?.state === "loaded" &&
    monthResult.messages.some(
      (message) =>
        message.type === "file-uploading" &&
        message.senderDeviceId !== deviceId,
    );
  const committingIdentity = pendingFiles
    .filter((pending) => pending.status === "committing" && pending.attachment)
    .map((pending) => pending.id)
    .join("|");

  useEffect(() => {
    if (
      status?.state !== "signed-in" ||
      !isPanelVisible ||
      !hasUploadingMessages
    ) {
      return;
    }

    const intervals = [2_000, 5_000, 8_000, 10_000];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intervalIndex = 0;
    let elapsed = 0;

    const schedule = () => {
      const delayMs = intervals[intervalIndex]!;
      timer = setTimeout(async () => {
        elapsed += delayMs;
        try {
          const response = await sendRequest({
            type: "messages/read-current-month",
          });
          if (!cancelled && response.ok && response.type === "messages/month") {
            setMonthResult((current) =>
              JSON.stringify(current) === JSON.stringify(response.result)
                ? current
                : response.result,
            );
          }
        } catch {
          // A foreground synchronization failure is transient. The next
          // scheduled check or an explicit refresh will try again.
        }
        if (cancelled) return;
        if (elapsed >= 120_000) return;
        intervalIndex = Math.min(intervalIndex + 1, intervals.length - 1);
        schedule();
      }, delayMs);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasUploadingMessages, isPanelVisible, status?.state]);

  useEffect(() => {
    const reconcileWhenOnline = () => {
      for (const pending of pendingFiles) {
        if (pending.status === "committing" && pending.attachment) {
          void retryFileCommit(pending);
        } else if (pending.status === "upload-failed") {
          void sendRequest({
            type: "files/discard-placeholder",
            messageId: pending.id,
          }).catch(() => undefined);
        }
      }
    };
    window.addEventListener("online", reconcileWhenOnline);
    return () => window.removeEventListener("online", reconcileWhenOnline);
  }, [pendingFiles]);

  useEffect(() => {
    if (!isPanelVisible || !committingIdentity) return;
    const intervals = [2_000, 5_000, 8_000, 10_000];
    const pendingCommits = pendingFiles.filter(
      (pending) => pending.status === "committing" && pending.attachment,
    );
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intervalIndex = 0;
    let elapsed = 0;

    const schedule = () => {
      const delayMs = intervals[intervalIndex]!;
      timer = setTimeout(async () => {
        elapsed += delayMs;
        for (const pending of pendingCommits) {
          if (cancelled) return;
          await retryFileCommit(pending);
        }
        if (cancelled || elapsed >= 120_000) return;
        intervalIndex = Math.min(intervalIndex + 1, intervals.length - 1);
        schedule();
      }, delayMs);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [committingIdentity, isPanelVisible]);

  useEffect(() => {
    async function restore() {
      setIsWorking(true);

      try {
        const restoredStatus = await sendAuthRequest({ type: "auth/status" });
        setStatus(restoredStatus);

        if (restoredStatus.state === "signed-in") {
          await loadOneDriveState();
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Unable to read status",
        );
      } finally {
        setIsWorking(false);
      }
    }

    void restore();
  }, []);

  async function readCachedTimeline(): Promise<MonthReadResult | undefined> {
    try {
      const month = getUtcMonth();
      const cached = await getMonthCache(month);
      if (!cached) return undefined;
      return {
        state: "loaded",
        month,
        eTag: cached.eTag,
        messages: cached.document.messages,
      };
    } catch {
      // The cache is an optional startup optimization. A damaged or
      // unavailable IndexedDB must never prevent a fresh OneDrive sync.
      return undefined;
    }
  }

  async function loadOneDriveState(restoreTransfers = true) {
    const devicePromise = sendRequest({ type: "device/id" });
    const folderPromise = sendRequest({ type: "onedrive/verify-app-folder" });
    const cachePromise = readCachedTimeline();
    const [deviceResponse, cachedTimeline] = await Promise.all([
      devicePromise,
      cachePromise,
    ]);
    if (!deviceResponse.ok || deviceResponse.type !== "device/id") {
      throw new Error("OneDrop could not identify this Edge installation.");
    }
    setDeviceId(deviceResponse.deviceId);
    if (cachedTimeline) setMonthResult(cachedTimeline);

    const folderResponse = await folderPromise;
    if (!folderResponse.ok || folderResponse.type !== "onedrive/app-folder") {
      throw new Error("OneDrop received an unexpected OneDrive response.");
    }

    const monthResponse = await sendRequest({
      type: "messages/read-current-month",
    });

    if (!monthResponse.ok || monthResponse.type !== "messages/month") {
      throw new Error("OneDrop received an unexpected monthly sync response.");
    }

    setMonthResult(monthResponse.result);
    if (restoreTransfers) {
      await Promise.all([
        restorePendingFiles(monthResponse.result),
        restorePendingTexts(monthResponse.result),
      ]);
    }
  }

  async function run(request: RuntimeRequest) {
    setIsWorking(true);
    setError(undefined);

    try {
      const nextStatus = await sendAuthRequest(request);
      setStatus(nextStatus);
      setMonthResult(undefined);

      if (request.type === "auth/sign-in" && nextStatus.state === "signed-in") {
        await loadOneDriveState();
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function retryLoad() {
    setIsWorking(true);
    setError(undefined);

    try {
      await loadOneDriveState();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "OneDrive synchronization failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function refreshTimeline() {
    setIsWorking(true);
    setError(undefined);
    try {
      await loadOneDriveState(false);
      setAttachmentCheckVersion((version) => version + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "OneDrive refresh failed",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function sendText() {
    if (!draft.trim() || isSendingRef.current) return;

    const pending: PendingText = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      text: draft.trim(),
      status: "sending",
    };
    await putPendingText(pending);
    setPendingTexts((items) => [...items, pending]);
    setDraft("");
    await sendPendingText(pending);
  }

  async function sendPendingText(pending: PendingText) {
    if (isSendingRef.current) return;

    isSendingRef.current = true;
    setIsSending(true);
    setIsWorking(true);
    setError(undefined);
    const sentAt = new Date().toISOString();
    await updatePendingText(pending.id, { status: "sending" });
    setPendingTexts((items) =>
      items.map((item) =>
        item.id === pending.id ? { ...item, status: "sending" } : item,
      ),
    );

    try {
      const response = await sendRequest({
        type: "messages/send-text",
        text: pending.text,
        messageId: pending.id,
        createdAt: sentAt,
      });

      if (!response.ok || response.type !== "messages/month") {
        throw new Error("OneDrop received an unexpected send response.");
      }

      setMonthResult(response.result);
      setScrollRevision((revision) => revision + 1);
      await deletePendingText(pending.id);
      setPendingTexts((items) =>
        items.filter((item) => item.id !== pending.id),
      );
    } catch (cause) {
      const error =
        cause instanceof Error ? cause.message : "Text message send failed";
      await updatePendingText(pending.id, {
        status: "send-failed",
        error,
      });
      setPendingTexts((items) =>
        items.map((item) =>
          item.id === pending.id
            ? { ...item, status: "send-failed", error }
            : item,
        ),
      );
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
      setIsWorking(false);
    }
  }

  function handleTimelineScroll() {
    setIsTimelineScrolling(true);
    scheduleScrollbarHide();
  }

  function handleTimelineMouseEnter() {
    isTimelineHoveredRef.current = true;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    setIsTimelineScrolling(true);
  }

  function handleTimelineMouseLeave() {
    isTimelineHoveredRef.current = false;
    scheduleScrollbarHide();
  }

  function scheduleScrollbarHide() {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      if (!isTimelineHoveredRef.current) setIsTimelineScrolling(false);
    }, 1_800);
  }

  async function selectFile(file: File) {
    const reselectId = reselectPendingIdRef.current;
    reselectPendingIdRef.current = null;
    const existing = reselectId
      ? pendingFiles.find((item) => item.id === reselectId)
      : undefined;
    const isImage = file.type.startsWith("image/");
    const imageMetadata = isImage
      ? await readLocalImageMetadata(file)
      : undefined;
    const pending: PendingFile = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      file,
      isImage,
      ...(imageMetadata ?? {}),
      ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
      status: "uploading",
    };
    if (existing?.previewUrl) URL.revokeObjectURL(existing.previewUrl);
    await putPendingTransfer({
      id: pending.id,
      createdAt: pending.createdAt,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified,
      blob: file,
      isImage: pending.isImage,
      ...(pending.imageWidth ? { imageWidth: pending.imageWidth } : {}),
      ...(pending.imageHeight ? { imageHeight: pending.imageHeight } : {}),
      ...(pending.thumbHash ? { thumbHash: pending.thumbHash } : {}),
      status: "uploading",
    });
    setPendingFiles((items) => [
      ...items.filter((item) => item.id !== pending.id),
      pending,
    ]);
    await uploadPendingFile(pending);
  }

  async function uploadPendingFile(pending: PendingFile) {
    if (!pending.file) {
      reselectPendingIdRef.current = pending.id;
      fileInputRef.current?.click();
      return;
    }

    const isResend = pending.status !== "uploading";
    updatePending(pending.id, { status: "uploading" });
    if (isResend) await delay(320);

    if (pending.file.size > MAX_DIRECT_FILE_BYTES) {
      updatePending(pending.id, {
        status: "upload-failed",
        error:
          "This file requires the upcoming large-file upload session support.",
      });
      return;
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      updatePending(pending.id, {
        status: "upload-failed",
        error: "You appear to be offline. Reconnect and Resend.",
      });
      return;
    }

    try {
      let base64: string;
      try {
        base64 = await fileToBase64(pending.file);
      } catch {
        void updatePendingTransfer(pending.id, {
          status: "upload-failed",
          error: "The original file is no longer available. Select it again.",
        });
        setPendingFiles((items) =>
          items.map((item) => {
            if (item.id !== pending.id) return item;
            const withoutFile = { ...item };
            delete withoutFile.file;
            return {
              ...withoutFile,
              status: "upload-failed",
              error:
                "The original file is no longer available. Select it again.",
            };
          }),
        );
        return;
      }
      const response = await sendRequest({
        type: "files/send",
        file: {
          name: pending.file.name,
          mimeType: pending.file.type || "application/octet-stream",
          size: pending.file.size,
          base64,
          ...(pending.imageWidth ? { imageWidth: pending.imageWidth } : {}),
          ...(pending.imageHeight ? { imageHeight: pending.imageHeight } : {}),
          ...(pending.thumbHash ? { thumbHash: pending.thumbHash } : {}),
        },
        messageId: pending.id,
        createdAt: pending.createdAt,
        ...(isResend ? { reuseExisting: true } : {}),
      });
      handleFileTransferResponse(pending.id, response);
    } catch (cause) {
      updatePending(pending.id, {
        status: "upload-failed",
        error: getClientError(cause),
      });
    }
  }

  async function retryFileCommit(pending: PendingFile) {
    if (!pending.attachment) return;
    updatePending(pending.id, { status: "committing" });
    try {
      const response = await sendRequest({
        type: "files/retry-commit",
        attachment: pending.attachment,
        messageId: pending.id,
        createdAt: pending.createdAt,
      });
      handleFileTransferResponse(pending.id, response);
    } catch (cause) {
      updatePending(pending.id, {
        status: "committing",
        error: getClientError(cause),
      });
    }
  }

  function handleFileTransferResponse(id: string, response: RuntimeResponse) {
    if (!response.ok || response.type !== "files/transfer") {
      updatePending(id, {
        status: "upload-failed",
        error: "OneDrop received an unexpected file transfer response.",
      });
      return;
    }
    if (response.transfer.state === "sent") {
      setMonthResult(response.transfer.result);
      removePending(id);
    } else if (response.transfer.state === "upload-failed") {
      updatePending(id, {
        status: "upload-failed",
        error: response.transfer.error,
      });
    } else if (response.transfer.state === "reconciling") {
      updatePending(id, {
        status: "committing",
        error: response.transfer.error,
        attachment: response.transfer.attachment,
        createdAt: response.transfer.createdAt,
      });
    }
  }

  function updatePending(id: string, patch: Partial<PendingFile>) {
    void updatePendingTransfer(id, patch);
    setPendingFiles((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function removePending(id: string) {
    void deletePendingTransfer(id);
    setPendingFiles((items) => {
      const removed = items.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return items.filter((item) => item.id !== id);
    });
  }

  async function restorePendingFiles(result: MonthReadResult) {
    const committedIds = new Set(
      result.state === "loaded"
        ? result.messages
            .filter((message) => message.type !== "file-uploading")
            .map((message) => message.id)
        : [],
    );
    const records = await listPendingTransfers();
    const restored: PendingFile[] = [];

    for (const record of records) {
      if (committedIds.has(record.id)) {
        await deletePendingTransfer(record.id);
        continue;
      }
      const status =
        record.status === "uploading"
          ? "upload-failed"
          : record.status === "commit-failed"
            ? "committing"
            : record.status;
      const error =
        record.status === "uploading"
          ? "The transfer was interrupted. Resend to continue."
          : record.error;
      if (record.status === "uploading") {
        await updatePendingTransfer(record.id, {
          status,
          ...(error ? { error } : {}),
        });
      }
      const file = new File([record.blob], record.name, {
        type: record.mimeType,
        lastModified: record.lastModified,
      });
      restored.push({
        id: record.id,
        createdAt: record.createdAt,
        file,
        isImage: record.isImage,
        ...(record.imageWidth ? { imageWidth: record.imageWidth } : {}),
        ...(record.imageHeight ? { imageHeight: record.imageHeight } : {}),
        ...(record.thumbHash ? { thumbHash: record.thumbHash } : {}),
        status,
        ...(error ? { error } : {}),
        ...(record.attachment ? { attachment: record.attachment } : {}),
        ...(record.isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
    }
    setPendingFiles(restored);
    for (const pending of restored) {
      if (pending.status === "committing" && pending.attachment) {
        void retryFileCommit(pending);
      } else if (pending.status === "upload-failed") {
        void sendRequest({
          type: "files/discard-placeholder",
          messageId: pending.id,
        }).catch(() => undefined);
      }
    }
  }

  async function restorePendingTexts(result: MonthReadResult) {
    const committedIds = new Set(
      result.state === "loaded"
        ? result.messages.map((message) => message.id)
        : [],
    );
    const records = await listPendingTexts();
    const restored: PendingText[] = [];
    for (const record of records) {
      if (committedIds.has(record.id)) {
        await deletePendingText(record.id);
        continue;
      }
      const status =
        record.status === "sending" ? "send-failed" : record.status;
      const error =
        record.status === "sending"
          ? "The message send was interrupted. Resend to continue."
          : record.error;
      if (record.status === "sending") {
        await updatePendingText(record.id, {
          status,
          ...(error ? { error } : {}),
        });
      }
      restored.push({ ...record, status, ...(error ? { error } : {}) });
    }
    setPendingTexts(restored);
  }

  function handleComposerKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }

    event.preventDefault();
    if (!isWorking && draft.trim()) void sendText();
  }

  const showUnifiedLoader =
    !error &&
    (!status || (status.state === "signed-in" && monthResult === undefined));

  return (
    <main className="shell">
      {status?.state === "unconfigured" ? (
        <section className="card" aria-labelledby="configuration-title">
          <span className="eyebrow">Configuration required</span>
          <h2 id="configuration-title">Register the development extension</h2>
          <p>
            Create a Microsoft Entra app registration, add the redirect URI
            below, and place its Application (client) ID in{" "}
            <code>.env.local</code>.
          </p>
          <RedirectUri value={status.redirectUri} />
        </section>
      ) : null}

      {status?.state === "signed-out" ? (
        <section className="card" aria-labelledby="sign-in-title">
          <span className="eyebrow">Ready to verify</span>
          <h2 id="sign-in-title">Connect your Microsoft account</h2>
          <p>
            This test requests access only to OneDrop&apos;s dedicated OneDrive
            App Folder. No files or messages will be created yet.
          </p>
          <button
            className="primary-button"
            disabled={isWorking}
            onClick={() => void run({ type: "auth/sign-in" })}
            type="button"
          >
            {isWorking ? "Opening Microsoft…" : "Sign in with Microsoft"}
          </button>
          <RedirectUri value={status.redirectUri} />
        </section>
      ) : null}

      {status?.state === "signed-in" ? (
        <div className="signed-in-layout">
          <section
            className="account-card"
            aria-label="Connected account"
            ref={accountCardRef}
          >
            <button
              aria-expanded={isAccountOpen}
              className="account-summary"
              onClick={() => setIsAccountOpen((open) => !open)}
              type="button"
            >
              <span className="account-avatar" aria-hidden="true">
                {getAccountInitial(status)}
              </span>
              <span className="account-email">
                {status.account.username ?? "Microsoft account"}
              </span>
            </button>
            <button
              aria-label="Refresh messages and files"
              className="account-refresh"
              disabled={isWorking}
              onClick={() => void refreshTimeline()}
              type="button"
            >
              {isWorking ? <LoadingIcon /> : <RefreshIcon />}
            </button>
            {isAccountOpen ? (
              <div className="account-popover">
                <strong>
                  {status.account.displayName ?? "Microsoft account"}
                </strong>
                {status.account.username ? (
                  <span>{status.account.username}</span>
                ) : null}
                <button
                  className="account-popover-signout"
                  disabled={isWorking}
                  onClick={() => void run({ type: "auth/sign-out" })}
                  type="button"
                >
                  Sign out
                </button>
                <button className="account-popover-add" disabled type="button">
                  Add account — coming later
                </button>
              </div>
            ) : null}
          </section>
          <section className="conversation" aria-label="OneDrop messages">
            {monthResult ? (
              <>
                <div
                  className={`message-scroll${isTimelineScrolling ? " is-scrolling" : ""}`}
                  onMouseEnter={handleTimelineMouseEnter}
                  onMouseLeave={handleTimelineMouseLeave}
                  onScroll={handleTimelineScroll}
                  ref={timelineScrollRef}
                >
                  <div className="message-content">
                    <MonthResult
                      attachmentCheckVersion={attachmentCheckVersion}
                      deviceId={deviceId}
                      pendingFiles={pendingFiles}
                      pendingTexts={pendingTexts}
                      result={monthResult}
                      onResend={(item) => void uploadPendingFile(item)}
                      onTextResend={(item) => void sendPendingText(item)}
                    />
                  </div>
                </div>
                <div className="composer">
                  <div className="composer-field">
                    <label className="sr-only" htmlFor="message-text">
                      Message
                    </label>
                    <textarea
                      id="message-text"
                      maxLength={20_000}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      placeholder="Message"
                      ref={composerRef}
                      rows={1}
                      value={draft}
                    />
                    {draft.trim() ? (
                      <button
                        aria-label="Send message"
                        className="send-icon"
                        disabled={isWorking}
                        onClick={() => void sendText()}
                        type="button"
                      >
                        {isSending ? <LoadingIcon /> : <SendIcon />}
                      </button>
                    ) : null}
                  </div>
                  <button
                    aria-label="Attach file"
                    className="attach-button"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <PlusIcon />
                  </button>
                  <input
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void selectFile(file);
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                </div>
              </>
            ) : null}
          </section>
        </div>
      ) : null}

      {showUnifiedLoader ? <UnifiedPulseLoader /> : null}

      {error ? (
        <div className="error" role="alert">
          <strong>Operation failed</strong>
          <span>{error}</span>
          {status?.state === "signed-in" && !monthResult ? (
            <button
              disabled={isWorking}
              onClick={() => void retryLoad()}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function UnifiedPulseLoader() {
  return (
    <div
      aria-label="Starting and synchronizing OneDrop"
      className="unified-pulse-loader"
      role="status"
    >
      <span className="unified-pulse" aria-hidden="true">
        <span className="unified-pulse-core" />
        <span className="unified-pulse-ring unified-pulse-ring-one" />
        <span className="unified-pulse-ring unified-pulse-ring-two" />
        <span className="unified-pulse-ring unified-pulse-ring-three" />
      </span>
    </div>
  );
}

export function PendingFileList({
  items,
  onResend,
}: {
  items: PendingFile[];
  onResend: (item: PendingFile) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ol className="pending-file-list" aria-label="Pending file transfers">
      {items.map((item) => (
        <li key={item.id}>
          <PendingFileItem item={item} onResend={onResend} />
        </li>
      ))}
    </ol>
  );
}

function PendingFileItem({
  item,
  onResend,
}: {
  item: PendingFile;
  onResend: (item: PendingFile) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const isActive = item.status === "uploading" || item.status === "committing";

  useEffect(() => {
    if (!isMenuOpen) return;
    function closeControls(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !controlsRef.current?.contains(event.target)
      ) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeControls);
    return () => document.removeEventListener("pointerdown", closeControls);
  }, [isMenuOpen]);

  function retryTransfer() {
    setIsMenuOpen(false);
    onResend(item);
  }

  return (
    <div className="pending-transfer-row" ref={controlsRef}>
      <span className="pending-primary-actions">
        {!isActive ? (
          <button
            className="pending-retry-button"
            onClick={retryTransfer}
            type="button"
          >
            <RetryIcon />
            Resend
          </button>
        ) : null}
        <button
          aria-expanded={isMenuOpen}
          aria-label="More transfer actions"
          className="pending-more-button"
          onClick={() => setIsMenuOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">•••</span>
        </button>
      </span>
      {isMenuOpen ? (
        <span className="pending-actions-menu" role="menu">
          {isActive ? (
            <button disabled role="menuitem" type="button">
              {item.status === "committing"
                ? "Finishing message…"
                : "Upload in progress"}
            </button>
          ) : (
            <button onClick={retryTransfer} role="menuitem" type="button">
              <RetryIcon />
              Resend
            </button>
          )}
          <button disabled role="menuitem" type="button">
            Delete message
            <small>Coming soon</small>
          </button>
        </span>
      ) : null}
      {isActive ? (
        <span className="pending-transfer-spinner">
          <LoadingIcon />
        </span>
      ) : (
        <span aria-label="Transfer error" className="pending-transfer-error">
          <span aria-hidden="true">!</span>
        </span>
      )}
      <div
        className={`pending-file-bubble ${item.isImage ? "pending-image-bubble" : "pending-document-bubble"}${isActive ? "" : " pending-attachment-error"}`}
      >
        {item.isImage && item.previewUrl ? (
          <div className="pending-image">
            <img
              alt={item.file?.name ?? "Pending image"}
              src={item.previewUrl}
            />
            {!isActive ? (
              <span className="pending-image-error-copy">Upload failed</span>
            ) : null}
          </div>
        ) : (
          <div className="file-attachment pending-file-attachment">
            <FileTypeIcon
              name={item.file?.name ?? item.attachment?.name ?? "File"}
            />
            <span className="file-attachment-copy">
              <strong>{item.file?.name ?? item.attachment?.name}</strong>
              <small
                className={isActive ? undefined : "pending-file-error-copy"}
              >
                {isActive
                  ? formatBytes(item.file?.size ?? item.attachment?.size ?? 0)
                  : "Upload failed"}
              </small>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function RetryIcon() {
  return (
    <svg aria-hidden="true" className="retry-icon" viewBox="0 0 16 16">
      <path d="M13 7.1A5.25 5.25 0 1 0 11.5 11.8" />
      <path d="M10.55 3.55H13v2.5" />
    </svg>
  );
}

function OpenLocalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M8.2 4.5H5.4a1.9 1.9 0 0 0-1.9 1.9v8.2a1.9 1.9 0 0 0 1.9 1.9h8.2a1.9 1.9 0 0 0 1.9-1.9v-2.8" />
      <path d="M11 3.5h5.5V9M16.2 3.8 9.1 10.9" />
    </svg>
  );
}

function DownloadLocalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 3.2v9.2M6.6 9.2l3.4 3.4 3.4-3.4M4 16.5h12" />
    </svg>
  );
}

function MonthResult({
  attachmentCheckVersion,
  deviceId,
  pendingFiles,
  pendingTexts,
  result,
  onResend,
  onTextResend,
}: {
  attachmentCheckVersion: number;
  deviceId: string | undefined;
  pendingFiles: PendingFile[];
  pendingTexts: PendingText[];
  result: MonthReadResult;
  onResend: (item: PendingFile) => void;
  onTextResend: (item: PendingText) => void;
}) {
  const timelineGroups = groupTimelineItems(
    result.state === "loaded" ? result.messages : [],
    pendingFiles,
    deviceId,
    pendingTexts,
  );

  return (
    <div className="month-result" aria-live="polite">
      {timelineGroups.length === 0 ? (
        <span className="empty-timeline">No messages yet</span>
      ) : (
        <ol className="message-list">
          {timelineGroups.map((group) => (
            <li
              className={group.isOwn ? "message-own" : undefined}
              key={getTimelineItemId(group.items[0]!)}
            >
              <time dateTime={getTimelineItemCreatedAt(group.items[0]!)}>
                {formatGroupTime(getTimelineItemCreatedAt(group.items[0]!))}
              </time>
              <div className="message-group-bubbles">
                {group.items.map((item) =>
                  item.kind === "pending-file" ? (
                    <PendingFileItem
                      item={item.pending}
                      key={item.pending.id}
                      onResend={onResend}
                    />
                  ) : item.kind === "pending-text" ? (
                    <PendingTextItem
                      item={item.pending}
                      key={item.pending.id}
                      onResend={onTextResend}
                    />
                  ) : item.message.type === "file-uploading" ? (
                    <UploadingFileMessageItem
                      isOwn={group.isOwn}
                      key={item.message.id}
                      message={item.message}
                    />
                  ) : (
                    <CommittedMessageItem
                      checkVersion={attachmentCheckVersion}
                      isOwn={group.isOwn}
                      key={item.message.id}
                      message={item.message}
                    />
                  ),
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PendingTextItem({
  item,
  onResend,
}: {
  item: PendingText;
  onResend: (item: PendingText) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [lineLayout, setLineLayout] = useState<"one" | "two" | "many">("many");
  const rowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      const lines = Math.max(1, Math.round(text.scrollHeight / lineHeight));
      setLineLayout(lines === 1 ? "one" : lines === 2 ? "two" : "many");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [item.text]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rowRef.current?.contains(event.target)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isMenuOpen]);

  return (
    <div className={`pending-text-row pending-text-${lineLayout}`} ref={rowRef}>
      <div className="message-bubble pending-text-bubble">
        <p ref={textRef}>{item.text}</p>
      </div>
      <span className="pending-text-primary-actions">
        <button
          className="pending-retry-button"
          disabled={item.status === "sending"}
          onClick={() => onResend(item)}
          type="button"
        >
          {item.status === "sending" ? <LoadingIcon /> : <RetryIcon />}
          Resend
        </button>
        <button
          aria-expanded={isMenuOpen}
          aria-label="More message actions"
          className="pending-more-button"
          onClick={() => setIsMenuOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">•••</span>
        </button>
      </span>
      {item.status === "send-failed" ? (
        <span className="pending-text-error">
          <AttachmentError />
        </span>
      ) : null}
      {isMenuOpen ? (
        <span className="pending-actions-menu" role="menu">
          <button onClick={() => onResend(item)} role="menuitem" type="button">
            <RetryIcon />
            Resend
          </button>
          <button disabled role="menuitem" type="button">
            Delete message
            <small>Coming soon</small>
          </button>
        </span>
      ) : null}
    </div>
  );
}

function UploadingFileMessageItem({
  isOwn,
  message,
}: {
  isOwn: boolean;
  message: UploadingFileMessage;
}) {
  return (
    <div
      className={`message-item-shell ${isOwn ? "message-item-own" : "message-item-peer"}`}
    >
      <div className="message-bubble message-attachment-bubble uploading-message-bubble">
        <div className="file-attachment">
          <FileTypeIcon name={message.pendingAttachment.name} />
          <span className="file-attachment-copy">
            <strong>{message.pendingAttachment.name}</strong>
            <small>Sending from another device…</small>
          </span>
        </div>
        <span
          aria-label="File upload in progress"
          className="uploading-message-indicator"
          role="status"
        >
          <LoadingIcon />
        </span>
      </div>
    </div>
  );
}

function CommittedMessageItem({
  checkVersion,
  isOwn,
  message,
}: {
  checkVersion: number;
  isOwn: boolean;
  message: ReadyMessage;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAttachmentWorking, setIsAttachmentWorking] = useState(false);
  const [localDownloadId, setLocalDownloadId] = useState<number | null>();
  const [cloudAvailability, setCloudAvailability] = useState<
    "checking" | "available" | "missing" | "unknown"
  >(message.type === "file" ? "checking" : "unknown");
  const shellRef = useRef<HTMLDivElement>(null);
  const isAttachment = message.type === "file";
  const isImage =
    isAttachment && message.attachment.mimeType.startsWith("image/");
  const isCloudMissing = cloudAvailability === "missing";

  useEffect(() => {
    let active = true;
    if (message.type !== "file") return;
    void getDownloadRecord(message.attachment.driveItemId)
      .then(async (record) => {
        if (!record) {
          if (active) setLocalDownloadId(null);
          return;
        }
        const [download] = await browser.downloads.search({
          id: record.downloadId,
        });
        const isAvailable =
          download?.state === "complete" && download.exists !== false;
        if (!isAvailable) {
          await deleteDownloadRecord(message.attachment.driveItemId);
          if (active) setLocalDownloadId(null);
          return;
        }
        if (active) setLocalDownloadId(record.downloadId);
      })
      .catch(() => {
        if (active) setLocalDownloadId(null);
      });
    return () => {
      active = false;
    };
  }, [message]);

  useEffect(() => {
    if (message.type === "file") setCloudAvailability("checking");
  }, [checkVersion, message]);

  useEffect(() => {
    if (!isMenuOpen) return;
    function closeMenu(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !shellRef.current?.contains(event.target)
      ) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [isMenuOpen]);

  async function copyMessageValue() {
    const value =
      message.type === "text" ? message.text : message.attachment.name;
    await navigator.clipboard.writeText(value);
    setIsMenuOpen(false);
  }

  async function requestAttachmentDownload(
    saveAs: boolean,
    forceDownload = false,
  ) {
    if (message.type !== "file") return;
    try {
      const response = await sendRequest({
        type: saveAs ? "files/save-as" : "files/open-local",
        attachment: message.attachment,
        ...(saveAs ? {} : { forceDownload }),
      });
      if (response.ok && response.type === "files/local-action") {
        setLocalDownloadId(response.downloadId);
      }
    } finally {
      setIsAttachmentWorking(false);
    }
  }

  function runAttachmentAction(saveAs: boolean) {
    if (message.type !== "file" || isAttachmentWorking || isCloudMissing) {
      return;
    }
    setIsAttachmentWorking(true);
    setIsMenuOpen(false);

    if (!saveAs && typeof localDownloadId === "number") {
      const downloadId = localDownloadId;
      void browser.downloads
        .open(downloadId)
        .then(() =>
          markDownloadOpened(message.attachment.driveItemId, undefined),
        )
        .then(() => setIsAttachmentWorking(false))
        .catch(async () => {
          const [download] = await browser.downloads.search({ id: downloadId });
          const isMissing =
            !download ||
            download.exists === false ||
            download.state === "interrupted";

          if (!isMissing) {
            // Opening can also fail because the OS has no associated app. Do
            // not create a duplicate while the local file still exists.
            setIsAttachmentWorking(false);
            return;
          }

          await deleteDownloadRecord(message.attachment.driveItemId);
          setLocalDownloadId(null);
          await requestAttachmentDownload(false, true);
        });
      return;
    }

    void requestAttachmentDownload(saveAs);
  }

  function handleBubbleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isAttachment || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    runAttachmentAction(false);
  }

  return (
    <div
      className={`message-item-shell ${isOwn ? "message-item-own" : "message-item-peer"}`}
      ref={shellRef}
    >
      <div
        aria-busy={isAttachment ? isAttachmentWorking : undefined}
        className={`message-bubble${
          message.type === "file"
            ? ` message-attachment-bubble message-attachment-action${isCloudMissing ? " attachment-action-disabled" : ""}${isAttachmentWorking ? " attachment-action-working" : ""}${isImage ? " message-image-bubble" : ""}`
            : ""
        }`}
        onClick={
          isAttachment && !isCloudMissing
            ? (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest(".attachment-error-control")
                ) {
                  return;
                }
                runAttachmentAction(false);
              }
            : undefined
        }
        onKeyDown={handleBubbleKeyDown}
        role={isAttachment && !isCloudMissing ? "button" : undefined}
        tabIndex={isAttachment && !isCloudMissing ? 0 : undefined}
      >
        {message.type === "text" ? (
          <p>{message.text}</p>
        ) : isImage ? (
          <ImageAttachment
            attachment={message.attachment}
            checkVersion={checkVersion}
            onAvailabilityChange={setCloudAvailability}
          />
        ) : (
          <FileAttachment
            attachment={message.attachment}
            checkVersion={checkVersion}
            onAvailabilityChange={setCloudAvailability}
          />
        )}
      </div>
      <span className="message-primary-actions">
        {message.type === "file" &&
        !isCloudMissing &&
        localDownloadId !== undefined ? (
          <button
            aria-label={
              localDownloadId === null ? "Download file" : "Open file"
            }
            className="message-local-button"
            onClick={() => runAttachmentAction(false)}
            type="button"
          >
            {localDownloadId === null ? (
              <DownloadLocalIcon />
            ) : (
              <OpenLocalIcon />
            )}
          </button>
        ) : null}
        <button
          aria-expanded={isMenuOpen}
          aria-label="More message actions"
          className="message-more-button"
          onClick={() => setIsMenuOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">•••</span>
        </button>
      </span>
      {isMenuOpen ? (
        <span className="message-actions-menu" role="menu">
          {message.type === "file" && !isCloudMissing ? (
            <button
              onClick={() => runAttachmentAction(true)}
              role="menuitem"
              type="button"
            >
              Save as
            </button>
          ) : null}
          <button
            onClick={() => void copyMessageValue()}
            role="menuitem"
            type="button"
          >
            {message.type === "text" ? "Copy text" : "Copy file name"}
          </button>
          <button disabled role="menuitem" type="button">
            Delete message
            <small>Coming soon</small>
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function ImageAttachment({
  attachment,
  checkVersion = 0,
  onAvailabilityChange,
}: {
  attachment: Attachment;
  checkVersion?: number;
  onAvailabilityChange?: (
    availability: "checking" | "available" | "missing" | "unknown",
  ) => void;
}) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [isMissing, setIsMissing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const thumbHashUrl = decodeThumbHash(attachment.thumbHash);

  useEffect(() => {
    let active = true;
    onAvailabilityChange?.("checking");
    void (async () => {
      const exists = await checkAttachmentAvailability(attachment.driveItemId);
      if (!active) return;
      if (exists === false) {
        onAvailabilityChange?.("missing");
        setDataUrl(undefined);
        setIsMissing(true);
        return;
      }
      onAvailabilityChange?.(exists ? "available" : "unknown");
      setIsMissing(false);
      try {
        const response = await sendRequest({
          type: "files/read-preview",
          driveItemId: attachment.driveItemId,
          mimeType: attachment.mimeType,
        });
        if (active && response.ok && response.type === "files/preview") {
          await decodeImagePreview(response.dataUrl);
          if (!active) return;
          setDataUrl(response.dataUrl);
        } else if (active) {
          setPreviewFailed(true);
        }
      } catch {
        if (active) setPreviewFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    attachment.driveItemId,
    attachment.mimeType,
    checkVersion,
    onAvailabilityChange,
  ]);

  return (
    <>
      <div className="image-attachment">
        {dataUrl ? (
          <img alt={attachment.name} className="image-preview" src={dataUrl} />
        ) : isMissing ? (
          <ImagePlaceholderState
            kind="missing"
            label="Not found in OneDrive"
            {...(thumbHashUrl ? { thumbHashUrl } : {})}
          />
        ) : previewFailed ? (
          <ImagePlaceholderState
            kind="preview"
            label="Preview unavailable"
            {...(thumbHashUrl ? { thumbHashUrl } : {})}
          />
        ) : (
          <ImagePlaceholderState
            kind="loading"
            {...(thumbHashUrl ? { thumbHashUrl } : {})}
          />
        )}
      </div>
      {isMissing || previewFailed ? <AttachmentError /> : null}
    </>
  );
}

function ImagePlaceholderState({
  kind,
  label,
  thumbHashUrl,
}: {
  kind: "loading" | "preview" | "missing";
  label?: string;
  thumbHashUrl?: string;
}) {
  return (
    <span
      className={`image-${kind}-state${thumbHashUrl ? " has-thumbhash" : ""}`}
      {...(kind === "loading" ? { role: "status" } : {})}
    >
      {thumbHashUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className="image-thumbhash"
          src={thumbHashUrl}
        />
      ) : null}
      <span className="image-state-content">
        {kind === "loading" ? <LoadingIcon /> : <ImagePlaceholderIcon />}
        {label ? (
          <span>{label}</span>
        ) : (
          <span className="sr-only">Loading image</span>
        )}
      </span>
    </span>
  );
}

export function FileAttachment({
  attachment,
  checkVersion = 0,
  onAvailabilityChange,
}: {
  attachment: Attachment;
  checkVersion?: number;
  onAvailabilityChange?: (
    availability: "checking" | "available" | "missing" | "unknown",
  ) => void;
}) {
  const [availability, setAvailability] = useState<
    "checking" | "available" | "missing" | "unknown"
  >("checking");

  useEffect(() => {
    let active = true;
    setAvailability("checking");
    onAvailabilityChange?.("checking");
    void checkAttachmentAvailability(attachment.driveItemId).then((exists) => {
      if (!active) return;
      const nextAvailability =
        exists === undefined ? "unknown" : exists ? "available" : "missing";
      setAvailability(nextAvailability);
      onAvailabilityChange?.(nextAvailability);
    });
    return () => {
      active = false;
    };
  }, [attachment.driveItemId, checkVersion, onAvailabilityChange]);

  const isMissing = availability === "missing";

  return (
    <>
      <div className="file-attachment">
        <FileTypeIcon name={attachment.name} />
        <span className="file-attachment-copy">
          <strong>{attachment.name}</strong>
          <small className={isMissing ? "file-missing-copy" : undefined}>
            {isMissing ? "Not found in OneDrive" : formatBytes(attachment.size)}
          </small>
        </span>
        {availability === "checking" ? (
          <span
            aria-label="Checking file availability"
            className="file-checking-status"
            role="status"
          >
            <LoadingIcon />
          </span>
        ) : null}
      </div>
      {isMissing ? <AttachmentError /> : null}
    </>
  );
}

function AttachmentError() {
  return (
    <span className="attachment-error-control">
      <span aria-label="Attachment error" className="attachment-error">
        !
      </span>
    </span>
  );
}

function FileTypeIcon({ name }: { name: string }) {
  const extension = name.split(".").at(-1)?.toLocaleUpperCase().slice(0, 4);
  return (
    <span className="file-type-icon" aria-hidden="true">
      <svg viewBox="0 0 40 48">
        <path d="M7 2h18l10 10v34H7z" />
        <path d="M25 2v11h10" />
        <path d="M12 23h18M12 29h18M12 35h13" />
      </svg>
      {extension && extension.length <= 4 ? <b>{extension}</b> : null}
    </span>
  );
}

function ImagePlaceholderIcon() {
  return (
    <svg
      aria-hidden="true"
      className="image-placeholder-icon"
      viewBox="0 0 32 32"
    >
      <rect height="24" rx="3" width="26" x="3" y="4" />
      <circle cx="11" cy="12" r="2.5" />
      <path d="m6 24 7-7 5 5 3-3 5 5" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readLocalImageMetadata(
  file: File,
): Promise<
  { imageWidth: number; imageHeight: number; thumbHash: string } | undefined
> {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 100 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      return undefined;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const thumbHash = encodeBytesBase64(rgbaToThumbHash(width, height, rgba));
    const metadata = {
      imageWidth: bitmap.width,
      imageHeight: bitmap.height,
      thumbHash,
    };
    bitmap.close();
    return metadata;
  } catch {
    return undefined;
  }
}

function decodeThumbHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return thumbHashToDataURL(decodeBytesBase64(value));
  } catch {
    return undefined;
  }
}

function encodeBytesBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBytesBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decodeImagePreview(dataUrl: string): Promise<void> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  if (typeof image.decode === "function") {
    await image.decode();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Image decode failed")),
      {
        once: true,
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type TimelineItem =
  | { kind: "message"; message: Message }
  | { kind: "pending-file"; pending: PendingFile }
  | { kind: "pending-text"; pending: PendingText };

type TimelineGroup = {
  isOwn: boolean;
  senderKey: string;
  items: TimelineItem[];
};

export function groupTimelineItems(
  messages: Message[],
  pendingFiles: PendingFile[],
  deviceId: string | undefined,
  pendingTexts: PendingText[] = [],
): TimelineGroup[] {
  const localPendingIds = new Set([
    ...pendingFiles.map((pending) => pending.id),
    ...pendingTexts.map((pending) => pending.id),
  ]);
  const committedIds = new Set(
    messages
      .filter((message) => message.type !== "file-uploading")
      .map((message) => message.id),
  );
  const items: TimelineItem[] = [
    ...messages
      .filter(
        (message) =>
          message.type !== "file-uploading" || !localPendingIds.has(message.id),
      )
      .map((message): TimelineItem => ({ kind: "message", message })),
    ...pendingFiles
      .filter((pending) => !committedIds.has(pending.id))
      .map((pending): TimelineItem => ({ kind: "pending-file", pending })),
    ...pendingTexts
      .filter((pending) => !committedIds.has(pending.id))
      .map((pending): TimelineItem => ({ kind: "pending-text", pending })),
  ].sort(
    (left, right) =>
      getTimelineItemCreatedAt(left).localeCompare(
        getTimelineItemCreatedAt(right),
      ) || getTimelineItemId(left).localeCompare(getTimelineItemId(right)),
  );
  const groups: TimelineGroup[] = [];

  for (const item of items) {
    const isPending = item.kind !== "message";
    const message = item.kind === "message" ? item.message : undefined;
    const isOwn =
      isPending || Boolean(deviceId && message?.senderDeviceId === deviceId);
    const senderKey = isPending
      ? (deviceId ?? "local-pending")
      : (message?.senderDeviceId ?? getTimelineItemId(item));
    const previous = groups.at(-1);
    const previousItem = previous?.items.at(-1);
    const isNearPrevious =
      previousItem &&
      Date.parse(getTimelineItemCreatedAt(item)) -
        Date.parse(getTimelineItemCreatedAt(previousItem)) <=
        5 * 60 * 1000;

    if (
      previous &&
      previous.isOwn === isOwn &&
      previous.senderKey === senderKey &&
      isNearPrevious
    ) {
      previous.items.push(item);
    } else {
      groups.push({ isOwn, senderKey, items: [item] });
    }
  }
  return groups;
}

function getTimelineItemId(item: TimelineItem): string {
  return item.kind === "message" ? item.message.id : item.pending.id;
}

function getTimelineItemCreatedAt(item: TimelineItem): string {
  return item.kind === "message"
    ? item.message.createdAt
    : item.pending.createdAt;
}

async function checkAttachmentAvailability(
  driveItemId: string,
): Promise<boolean | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await sendRequest({
        type: "files/check-attachment",
        driveItemId,
      });
      if (response.ok && response.type === "files/availability") {
        if (response.exists || attempt === 2) return response.exists;
      }
    } catch {
      if (attempt === 2) return undefined;
    }
    await delay(400);
  }
  return undefined;
}

type MessageGroup = {
  isOwn: boolean;
  senderKey: string;
  messages: Message[];
};

export function groupMessages(
  messages: Message[],
  deviceId: string | undefined,
): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const isOwn = Boolean(deviceId && message.senderDeviceId === deviceId);
    const senderKey = message.senderDeviceId ?? message.id;
    const previous = groups.at(-1);
    const previousMessage = previous?.messages.at(-1);
    const isNearPrevious =
      previousMessage &&
      Date.parse(message.createdAt) - Date.parse(previousMessage.createdAt) <=
        5 * 60 * 1000;

    if (
      previous &&
      previous.senderKey === senderKey &&
      previous.isOwn === isOwn &&
      isNearPrevious
    ) {
      previous.messages.push(message);
    } else {
      groups.push({ isOwn, senderKey, messages: [message] });
    }
  }

  return groups;
}

function formatGroupTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { year: "numeric", month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getAccountInitial(
  status: Extract<AuthStatus, { state: "signed-in" }>,
) {
  const source =
    status.account.displayName?.trim() ||
    status.account.username?.trim() ||
    "M";
  return [...source][0]?.toLocaleUpperCase() ?? "M";
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m3.5 4.5 17 7.5-17 7.5 2.3-6.1L15 12l-9.2-1.4-2.3-6.1Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18.7 10M17.9 15.8A7 7 0 0 1 5.3 14" />
    </svg>
  );
}

function LoadingIcon() {
  return <span className="loading-spinner" aria-hidden="true" />;
}

function resizeComposer(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.max(40, Math.min(element.scrollHeight, 144))}px`;
  element.style.overflowY = element.scrollHeight > 144 ? "auto" : "hidden";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function getClientError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "File transfer failed";
}

function RedirectUri({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="redirect">
      <span>Redirect URI</span>
      <code>{value}</code>
      <button onClick={() => void copy()} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
