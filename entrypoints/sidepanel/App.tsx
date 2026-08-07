import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  AuthStatus,
  MonthReadResult,
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";
import type { Attachment, Message } from "../../src/domain/message";
import { MAX_DIRECT_FILE_BYTES } from "../../src/config/files";

export type PendingFile = {
  id: string;
  createdAt: string;
  file?: File;
  previewUrl?: string;
  isImage: boolean;
  status: "uploading" | "upload-failed" | "commit-failed";
  error?: string;
  attachment?: Attachment;
};

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
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
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

  useLayoutEffect(() => {
    const timeline = timelineScrollRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [monthResult, pendingFiles]);

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

  async function loadOneDriveState() {
    const deviceResponse = await sendRequest({ type: "device/id" });
    if (!deviceResponse.ok || deviceResponse.type !== "device/id") {
      throw new Error("OneDrop could not identify this Edge installation.");
    }
    setDeviceId(deviceResponse.deviceId);

    const folderResponse = await sendRequest({
      type: "onedrive/verify-app-folder",
    });

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

  async function sendText() {
    if (!draft.trim() || isSendingRef.current) return;

    isSendingRef.current = true;
    setIsSending(true);
    setIsWorking(true);
    setError(undefined);

    try {
      const response = await sendRequest({
        type: "messages/send-text",
        text: draft,
      });

      if (!response.ok || response.type !== "messages/month") {
        throw new Error("OneDrop received an unexpected send response.");
      }

      setMonthResult(response.result);
      setDraft("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Text message send failed",
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
    const pending: PendingFile = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      file,
      isImage: file.type.startsWith("image/"),
      ...(file.type.startsWith("image/")
        ? { previewUrl: URL.createObjectURL(file) }
        : {}),
      status: "uploading",
    };
    if (existing?.previewUrl) URL.revokeObjectURL(existing.previewUrl);
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

    if (pending.file.size > MAX_DIRECT_FILE_BYTES) {
      updatePending(pending.id, {
        status: "upload-failed",
        error:
          "This file requires the upcoming large-file upload session support.",
      });
      return;
    }

    updatePending(pending.id, { status: "uploading" });
    try {
      let base64: string;
      try {
        base64 = await fileToBase64(pending.file);
      } catch {
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
        },
        messageId: pending.id,
        createdAt: pending.createdAt,
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
    updatePending(pending.id, { status: "uploading" });
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
        status: "commit-failed",
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
    } else {
      updatePending(id, {
        status: "commit-failed",
        error: response.transfer.error,
        attachment: response.transfer.attachment,
      });
    }
  }

  function updatePending(id: string, patch: Partial<PendingFile>) {
    setPendingFiles((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function removePending(id: string) {
    setPendingFiles((items) => {
      const removed = items.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return items.filter((item) => item.id !== id);
    });
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

  return (
    <main className="shell">
      {!status ? (
        <section className="card" aria-live="polite">
          <span className="eyebrow">Loading</span>
          <h2>Reading extension status…</h2>
        </section>
      ) : null}

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
              className="account-action"
              disabled={isWorking}
              onClick={() => void run({ type: "auth/sign-out" })}
              type="button"
            >
              Sign out
            </button>
            {isAccountOpen ? (
              <div className="account-popover">
                <strong>
                  {status.account.displayName ?? "Microsoft account"}
                </strong>
                {status.account.username ? (
                  <span>{status.account.username}</span>
                ) : null}
                <button disabled type="button">
                  Add account — coming later
                </button>
              </div>
            ) : null}
          </section>
          <section className="conversation" aria-label="OneDrop messages">
            {!monthResult ? (
              <div className="timeline-loading" aria-live="polite">
                Synchronizing messages…
              </div>
            ) : (
              <>
                <div
                  className={`message-scroll${isTimelineScrolling ? " is-scrolling" : ""}`}
                  onMouseEnter={handleTimelineMouseEnter}
                  onMouseLeave={handleTimelineMouseLeave}
                  onScroll={handleTimelineScroll}
                  ref={timelineScrollRef}
                >
                  <MonthResult deviceId={deviceId} result={monthResult} />
                  <PendingFileList
                    items={pendingFiles}
                    onCommitRetry={(item) => void retryFileCommit(item)}
                    onResend={(item) => void uploadPendingFile(item)}
                  />
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
            )}
          </section>
        </div>
      ) : null}

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

export function PendingFileList({
  items,
  onCommitRetry,
  onResend,
}: {
  items: PendingFile[];
  onCommitRetry: (item: PendingFile) => void;
  onResend: (item: PendingFile) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ol className="pending-file-list" aria-label="Pending file transfers">
      {items.map((item) => (
        <li key={item.id}>
          <div className="pending-file-bubble">
            {item.isImage && item.previewUrl ? (
              <div className="pending-image">
                <img
                  alt={item.file?.name ?? "Pending image"}
                  src={item.previewUrl}
                />
                {item.status === "upload-failed" ? (
                  <span>Upload failed</span>
                ) : null}
              </div>
            ) : (
              <div className="pending-file-copy">
                <strong>{item.file?.name ?? item.attachment?.name}</strong>
                {item.status === "upload-failed" ? (
                  <span>Upload failed</span>
                ) : null}
              </div>
            )}
            {item.status === "uploading" ? (
              <span className="pending-transfer-spinner">
                <LoadingIcon />
              </span>
            ) : null}
          </div>
          {item.status !== "uploading" ? (
            <div className="pending-error-action" title={item.error}>
              <button
                onClick={() =>
                  item.status === "commit-failed"
                    ? onCommitRetry(item)
                    : onResend(item)
                }
                type="button"
              >
                {item.status === "commit-failed" ? "Retry" : "Resend"}
              </button>
              <span aria-label="Transfer error">!</span>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function MonthResult({
  deviceId,
  result,
}: {
  deviceId: string | undefined;
  result: MonthReadResult;
}) {
  return (
    <div className="month-result" aria-live="polite">
      {result.state === "missing" ? (
        <span className="empty-timeline">No messages yet</span>
      ) : (
        <ol className="message-list">
          {groupMessages(result.messages, deviceId).map((group) => (
            <li
              className={group.isOwn ? "message-own" : undefined}
              key={group.messages[0]!.id}
            >
              <time dateTime={group.messages[0]!.createdAt}>
                {formatGroupTime(group.messages[0]!.createdAt)}
              </time>
              <div className="message-group-bubbles">
                {group.messages.map((message) => (
                  <div className="message-bubble" key={message.id}>
                    {message.type === "text" ? (
                      <p>{message.text}</p>
                    ) : (
                      <p>File: {message.attachment.name}</p>
                    )}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
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
