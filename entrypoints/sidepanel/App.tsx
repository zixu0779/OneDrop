import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";

import type {
  ArchiveNotice,
  ArchiveRuntimeEvent,
  AuthStatus,
  FileTransferRuntimeEvent,
  MonthReadResult,
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";
import type {
  Attachment,
  Message,
  UploadingFileMessage,
} from "../../src/domain/message";
import {
  DEFAULT_UPLOAD_BYTES_PER_SECOND,
  MAX_DIRECT_FILE_BYTES,
} from "../../src/config/files";
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
  status: "uploading" | "committing" | "upload-failed" | "cancelled";
  error?: string;
  attachment?: Attachment;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
  progress?: number;
  progressTarget?: number;
  averageUploadBytesPerSecond?: number;
};

export type PendingText = {
  id: string;
  createdAt: string;
  text: string;
  status: "sending" | "send-failed";
  error?: string;
};

type ReadyMessage = Exclude<Message, { type: "file-uploading" }>;

function getNotificationDepth(
  index: number,
  activeIndex: number,
  count: number,
): number {
  return count === 0 ? 0 : (index - activeIndex + count) % count;
}

function formatArchiveMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

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

export type MonthReadToken = {
  requestVersion: number;
  writeVersion: number;
};

const FOREGROUND_SYNC_STALE_MS = 30_000;

export function shouldApplyMonthRead(
  token: MonthReadToken,
  latestRequestVersion: number | undefined,
  localOperationVersion: number,
  activeLocalWrites = 0,
): boolean {
  return (
    latestRequestVersion === token.requestVersion &&
    localOperationVersion === token.writeVersion &&
    activeLocalWrites === 0
  );
}

function withoutMessage(
  result: MonthReadResult,
  removedMessageId?: string,
): MonthReadResult {
  if (!removedMessageId || result.state !== "loaded") return result;
  return {
    ...result,
    messages: result.messages.filter(
      (message) => message.id !== removedMessageId,
    ),
  };
}

function mergeCurrentMonthSnapshots(
  current: MonthReadResult | undefined,
  incoming: MonthReadResult,
  deletedMessageIds: Set<string>,
): MonthReadResult {
  if (incoming.state !== "loaded") return current ?? incoming;
  const messages = new Map(
    incoming.messages
      .filter((message) => !deletedMessageIds.has(message.id))
      .map((message) => [message.id, message]),
  );
  if (current?.state === "loaded") {
    for (const message of current.messages) {
      if (!deletedMessageIds.has(message.id) && !messages.has(message.id)) {
        messages.set(message.id, message);
      }
    }
  }
  return {
    ...incoming,
    messages: [...messages.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    ),
  };
}

export function App() {
  const [status, setStatus] = useState<AuthStatus>();
  const [error, setError] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [monthResult, setMonthResult] = useState<MonthReadResult>();
  const [historicalMonthResults, setHistoricalMonthResults] = useState<
    MonthReadResult[]
  >([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [deviceId, setDeviceId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isAccountSwitcherOpen, setIsAccountSwitcherOpen] = useState(false);
  const [isTimelineScrolling, setIsTimelineScrolling] = useState(false);
  const [isTimelineScrollbarHovered, setIsTimelineScrollbarHovered] =
    useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [foregroundRevision, setForegroundRevision] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingTexts, setPendingTexts] = useState<PendingText[]>([]);
  const [isCreatingPendingText, setIsCreatingPendingText] = useState(false);
  const [sendingTextIds, setSendingTextIds] = useState<Set<string>>(new Set());
  const [deletingMessageIds, setDeletingMessageIds] = useState<Set<string>>(
    new Set(),
  );
  const [attachmentCheckVersion, setAttachmentCheckVersion] = useState(0);
  const [processingNoticeKey, setProcessingNoticeKey] = useState<string>();
  const [archiveNotices, setArchiveNotices] = useState<ArchiveNotice[]>([]);
  const [openingRecordItemId, setOpeningRecordItemId] = useState<string>();
  const [recordLocationError, setRecordLocationError] = useState<string>();
  const [
    showDeletedDataCleanupConfirmation,
    setShowDeletedDataCleanupConfirmation,
  ] = useState(false);
  const [deletedDataCleanupNotice, setDeletedDataCleanupNotice] = useState<{
    phase: "failed" | "succeeded";
    messages?: number;
    attachments?: number;
    error?: string;
  }>();
  const [isDeletedDataCleanupRunning, setIsDeletedDataCleanupRunning] =
    useState(false);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<{
    messageId: string;
    month: string;
  }>();
  const [activeNoticeIndex, setActiveNoticeIndex] = useState(0);
  const [noticeDragOffset, setNoticeDragOffset] = useState(0);
  const [isNoticeDragging, setIsNoticeDragging] = useState(false);
  const [noticeCycleDirection, setNoticeCycleDirection] = useState<
    1 | -1 | null
  >(null);
  const [noticeCycleMotion, setNoticeCycleMotion] = useState<"up" | "down">(
    "up",
  );
  const [noticeCycleGesture, setNoticeCycleGesture] = useState<
    "wheel" | "drag-up" | "drag-down"
  >("wheel");
  const [dismissedNoticeKeys, setDismissedNoticeKeys] = useState<Set<string>>(
    new Set(),
  );
  const [unresponsiveUploadIds, setUnresponsiveUploadIds] = useState<
    Set<string>
  >(new Set());
  const [refreshingUploadIds, setRefreshingUploadIds] = useState<Set<string>>(
    new Set(),
  );
  const [scrollRevision, setScrollRevision] = useState(0);
  const [optimisticallyDeletedMessageIds, setOptimisticallyDeletedMessageIds] =
    useState<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const accountCardRef = useRef<HTMLElement>(null);
  const isCreatingPendingTextRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const lastSuccessfulSyncAtRef = useRef(0);
  const localOperationVersionsRef = useRef<Map<string, number>>(new Map());
  const activeLocalWritesRef = useRef<Map<string, number>>(new Map());
  const readRequestVersionsRef = useRef<Map<string, number>>(new Map());
  const activePendingTextWriteIdsRef = useRef<Set<string>>(new Set());
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileDragDepthRef = useRef(0);
  const historyScrollHeightRef = useRef<number | undefined>(undefined);
  const historyLoadingHeightRef = useRef(0);
  const historyLoadingElementRef = useRef<HTMLSpanElement>(null);
  const historyLoadingRef = useRef(false);
  const historyCursorRef = useRef<string | undefined>(undefined);
  const reselectPendingIdRef = useRef<string | null>(null);
  const noticeDragStartYRef = useRef<number | null>(null);
  const noticeWheelLockedRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const preservedTimelineViewportRef = useRef<
    { scrollTop: number; scrollHeight: number } | undefined
  >(undefined);
  const forceScrollToBottomRef = useRef(false);
  const initialBottomFrameRef = useRef<number | undefined>(undefined);
  const isApplyingBottomScrollRef = useRef(false);
  const cancelledUploadIdsRef = useRef<Set<string>>(new Set());
  const noticeCycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const visibleCorruptFiles = (monthResult?.corruptFiles ?? []).filter(
    (file) => !dismissedNoticeKeys.has(`corrupt:${file.itemId}`),
  );
  const visibleMessageConflicts = (monthResult?.messageConflicts ?? []).filter(
    (conflict) => !dismissedNoticeKeys.has(`conflict:${conflict.messageId}`),
  );
  const corruptNoticeCount = visibleCorruptFiles.length;
  const conflictNoticeCount = visibleMessageConflicts.length;
  const notificationCount = corruptNoticeCount + conflictNoticeCount;
  const isSendingText = isCreatingPendingText;

  function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = writeQueueRef.current.catch(() => undefined).then(operation);
    writeQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  function applyWriteSnapshot(
    result: MonthReadResult,
    removedMessageId?: string,
  ) {
    const authoritativeResult = withoutMessage(result, removedMessageId);
    if (result.month === getUtcMonth()) {
      setMonthResult(authoritativeResult);
      return;
    }
    setHistoricalMonthResults((results) => {
      return results.map((item) =>
        item.month === result.month ? authoritativeResult : item,
      );
    });
  }

  function beginLocalWrite(
    month: string,
    blockReadsWhileActive = true,
  ): () => void {
    localOperationVersionsRef.current.set(
      month,
      (localOperationVersionsRef.current.get(month) ?? 0) + 1,
    );
    if (blockReadsWhileActive) {
      activeLocalWritesRef.current.set(
        month,
        (activeLocalWritesRef.current.get(month) ?? 0) + 1,
      );
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      localOperationVersionsRef.current.set(
        month,
        (localOperationVersionsRef.current.get(month) ?? 0) + 1,
      );
      if (blockReadsWhileActive) {
        const remaining = (activeLocalWritesRef.current.get(month) ?? 1) - 1;
        if (remaining > 0) activeLocalWritesRef.current.set(month, remaining);
        else activeLocalWritesRef.current.delete(month);
      }
    };
  }

  function beginMonthRead(month: string): MonthReadToken {
    const requestVersion = (readRequestVersionsRef.current.get(month) ?? 0) + 1;
    readRequestVersionsRef.current.set(month, requestVersion);
    return {
      requestVersion,
      writeVersion: localOperationVersionsRef.current.get(month) ?? 0,
    };
  }

  function applySynchronizedSnapshot(
    result: MonthReadResult,
    token: MonthReadToken,
  ): boolean {
    const canApplyDirectly = shouldApplyMonthRead(
      token,
      readRequestVersionsRef.current.get(result.month),
      localOperationVersionsRef.current.get(result.month) ?? 0,
      activeLocalWritesRef.current.get(result.month) ?? 0,
    );

    if (result.month === getUtcMonth()) {
      if (canApplyDirectly) {
        setMonthResult(result);
      } else {
        setMonthResult((current) =>
          mergeCurrentMonthSnapshots(
            current,
            result,
            optimisticallyDeletedMessageIds,
          ),
        );
      }
      return true;
    }
    if (!canApplyDirectly) return false;
    setHistoricalMonthResults((results) =>
      results.map((current) =>
        current.month === result.month ? result : current,
      ),
    );
    return true;
  }

  useEffect(() => {
    const listener = (
      message: ArchiveRuntimeEvent | FileTransferRuntimeEvent,
    ) => {
      if (message?.type === "archives/event") {
        updateArchiveNotice(message.notice);
      } else if (message?.type === "files/progress") {
        const progress =
          message.totalBytes === 0
            ? 0
            : (message.uploadedBytes / message.totalBytes) * 100;
        const progressTarget =
          message.totalBytes === 0
            ? 0
            : (message.segmentEndBytes / message.totalBytes) * 100;
        updatePending(message.messageId, {
          progress,
          progressTarget,
          ...(message.averageUploadBytesPerSecond
            ? {
                averageUploadBytesPerSecond:
                  message.averageUploadBytesPerSecond,
              }
            : {}),
        });
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    setActiveNoticeIndex((index) =>
      notificationCount === 0 ? 0 : index % notificationCount,
    );
  }, [notificationCount]);

  useEffect(
    () => () => {
      if (noticeCycleTimerRef.current) {
        clearTimeout(noticeCycleTimerRef.current);
      }
    },
    [],
  );

  function cycleNotifications(
    direction: 1 | -1,
    motion: "up" | "down" = "up",
    gesture: "wheel" | "drag-up" | "drag-down" = "wheel",
  ) {
    if (notificationCount < 2 || isWorking || noticeCycleDirection !== null) {
      return;
    }

    setNoticeCycleGesture(gesture);
    setNoticeCycleMotion(motion);
    setNoticeCycleDirection(direction);
    noticeCycleTimerRef.current = setTimeout(() => {
      setActiveNoticeIndex(
        (index) => (index + direction + notificationCount) % notificationCount,
      );
      setNoticeCycleDirection(null);
      setNoticeDragOffset(0);
      noticeCycleTimerRef.current = null;
    }, 680);
  }

  function handleNotificationWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (
      Math.abs(event.deltaY) < 8 ||
      noticeWheelLockedRef.current ||
      noticeCycleDirection !== null
    )
      return;
    event.preventDefault();
    noticeWheelLockedRef.current = true;
    const direction = event.deltaY > 0 ? 1 : -1;
    setNoticeDragOffset(0);
    cycleNotifications(direction, event.deltaY > 0 ? "down" : "up");
    window.setTimeout(() => {
      noticeWheelLockedRef.current = false;
    }, 820);
  }

  function handleNotificationPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (noticeCycleDirection !== null) return;
    if (event.target instanceof Element && event.target.closest("button"))
      return;
    noticeDragStartYRef.current = event.clientY;
    setIsNoticeDragging(true);
    setNoticeDragOffset(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleNotificationPointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const startY = noticeDragStartYRef.current;
    if (startY === null) return;
    event.preventDefault();
    const distance = Math.max(-96, Math.min(96, event.clientY - startY));
    setNoticeDragOffset(distance);
  }

  function handleNotificationPointerUp(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const startY = noticeDragStartYRef.current;
    noticeDragStartYRef.current = null;
    setIsNoticeDragging(false);
    if (startY === null) return;
    const distance = event.clientY - startY;
    if (Math.abs(distance) >= 32) {
      cycleNotifications(
        distance < 0 ? 1 : -1,
        "up",
        distance < 0 ? "drag-up" : "drag-down",
      );
      return;
    }
    setNoticeDragOffset(0);
  }

  useLayoutEffect(() => {
    resizeComposer(composerRef.current);
  }, [draft]);

  const timelineIdentity = [
    ...historicalMonthResults.flatMap((result) =>
      result.state === "loaded"
        ? result.messages.map((message) => message.id)
        : [],
    ),
    ...(monthResult?.state === "loaded"
      ? monthResult.messages.map((message) => message.id)
      : []),
    ...pendingFiles.map((pending) => pending.id),
    ...pendingTexts.map((pending) => pending.id),
  ].join("|");

  function alignTimelineToBottom(timeline: HTMLDivElement) {
    isApplyingBottomScrollRef.current = true;
    timeline.scrollTop = timeline.scrollHeight;
    if (initialBottomFrameRef.current !== undefined) {
      cancelAnimationFrame(initialBottomFrameRef.current);
    }
    initialBottomFrameRef.current = requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
      initialBottomFrameRef.current = requestAnimationFrame(() => {
        timeline.scrollTop = timeline.scrollHeight;
        isApplyingBottomScrollRef.current = false;
        initialBottomFrameRef.current = undefined;
      });
    });
  }

  useLayoutEffect(() => {
    const timeline = timelineScrollRef.current;
    if (!timeline) return;
    const preservedViewport = preservedTimelineViewportRef.current;
    if (preservedViewport !== undefined) {
      timeline.scrollTop = Math.max(
        0,
        preservedViewport.scrollTop +
          timeline.scrollHeight -
          preservedViewport.scrollHeight,
      );
      preservedTimelineViewportRef.current = undefined;
      return;
    }
    if (shouldStickToBottomRef.current || forceScrollToBottomRef.current) {
      shouldStickToBottomRef.current = true;
      forceScrollToBottomRef.current = false;
      alignTimelineToBottom(timeline);
    }
  }, [timelineIdentity, scrollRevision]);

  useLayoutEffect(() => {
    const timeline = timelineScrollRef.current;
    const content = timelineContentRef.current;
    if (!timeline || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        alignTimelineToBottom(timeline);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [monthResult]);

  useLayoutEffect(() => {
    if (!isLoadingHistory) return;
    historyLoadingHeightRef.current =
      historyLoadingElementRef.current?.getBoundingClientRect().height ?? 0;
  }, [isLoadingHistory]);

  useLayoutEffect(() => {
    const timeline = timelineScrollRef.current;
    const previousHeight = historyScrollHeightRef.current;
    if (!timeline || previousHeight === undefined) return;
    timeline.scrollTop +=
      timeline.scrollHeight - previousHeight - historyLoadingHeightRef.current;
    historyScrollHeightRef.current = undefined;
    historyLoadingHeightRef.current = 0;
  }, [historicalMonthResults]);

  useEffect(() => {
    if (!isAccountOpen) return;

    function closeAccount(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountCardRef.current?.contains(event.target)
      ) {
        setIsAccountOpen(false);
        setIsAccountSwitcherOpen(false);
      }
    }

    function closeAccountWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAccountOpen(false);
        setIsAccountSwitcherOpen(false);
      }
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
    const markForeground = () => {
      setIsPanelVisible(true);
      setForegroundRevision((revision) => revision + 1);
    };
    const updateVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setIsPanelVisible(visible);
      if (visible) setForegroundRevision((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", markForeground);
    window.addEventListener("pageshow", markForeground);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", markForeground);
      window.removeEventListener("pageshow", markForeground);
    };
  }, []);

  useEffect(() => {
    if (
      !isPanelVisible ||
      status?.state !== "signed-in" ||
      !monthResult ||
      Date.now() - lastSuccessfulSyncAtRef.current < FOREGROUND_SYNC_STALE_MS
    ) {
      return;
    }
    void syncCurrentMonthSilently();
  }, [
    historicalMonthResults.map((result) => result.month).join("|"),
    foregroundRevision,
    isPanelVisible,
    monthResult?.month,
    status?.state,
  ]);

  const hasUploadingMessages =
    monthResult?.state === "loaded" &&
    monthResult.messages.some(
      (message) =>
        message.type === "file-uploading" &&
        message.senderDeviceId !== deviceId,
    );
  const remoteUploadingIds =
    monthResult?.state === "loaded"
      ? monthResult.messages
          .filter(
            (message) =>
              message.type === "file-uploading" &&
              message.senderDeviceId !== deviceId,
          )
          .map((message) => message.id)
      : [];
  const remoteUploadingIdentity = remoteUploadingIds.join("|");
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
          const readToken = beginMonthRead(getUtcMonth());
          const response = await sendRequest({
            type: "messages/read-current-month",
          });
          if (!cancelled && response.ok && response.type === "messages/month") {
            applySynchronizedSnapshot(response.result, readToken);
          }
        } catch {
          // A foreground synchronization failure is transient. The next
          // scheduled check or an explicit refresh will try again.
        }
        if (cancelled) return;
        if (elapsed >= 120_000) {
          setUnresponsiveUploadIds((current) => {
            const next = new Set(current);
            for (const id of remoteUploadingIds) next.add(id);
            return next;
          });
          return;
        }
        intervalIndex = Math.min(intervalIndex + 1, intervals.length - 1);
        schedule();
      }, delayMs);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    hasUploadingMessages,
    isPanelVisible,
    remoteUploadingIdentity,
    status?.state,
  ]);

  useEffect(() => {
    const active = new Set(remoteUploadingIds);
    setUnresponsiveUploadIds((current) => {
      const next = new Set([...current].filter((id) => active.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [remoteUploadingIdentity]);

  useEffect(() => {
    const reconcileWhenOnline = () => {
      for (const pending of pendingFiles) {
        if (pending.status === "committing" && pending.attachment) {
          void retryFileCommit(pending);
        } else if (pending.status === "upload-failed") {
          void discardPendingPlaceholder(pending.id);
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
      if (restoreInFlightRef.current) return;
      restoreInFlightRef.current = true;
      syncInFlightRef.current = true;
      setIsWorking(true);
      setIsSyncing(true);

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
        syncInFlightRef.current = false;
        restoreInFlightRef.current = false;
        setIsSyncing(false);
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

  async function loadOneDriveState(
    restoreTransfers = true,
    runArchiveMaintenance = true,
    preserveLoadedHistory = true,
  ) {
    const loadedHistoricalMonths = preserveLoadedHistory
      ? historicalMonthResults.map((result) => result.month)
      : [];
    if (!preserveLoadedHistory) {
      setHistoricalMonthResults([]);
      historyCursorRef.current = undefined;
    }
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
    if (cachedTimeline && !monthResult) setMonthResult(cachedTimeline);
    if (restoreTransfers) {
      const localReconciliationResult: MonthReadResult = cachedTimeline ?? {
        state: "missing",
        month: getUtcMonth(),
      };
      await Promise.allSettled([
        restorePendingFiles(localReconciliationResult),
        restorePendingTexts(localReconciliationResult),
      ]);
    }

    const folderResponse = await folderPromise;
    if (!folderResponse.ok || folderResponse.type !== "onedrive/app-folder") {
      throw new Error("OneDrop received an unexpected OneDrive response.");
    }

    const currentMonthReadToken = beginMonthRead(getUtcMonth());
    const monthResponse = await sendRequest({
      type: "messages/read-current-month",
    });

    if (!monthResponse.ok || monthResponse.type !== "messages/month") {
      throw new Error("OneDrop received an unexpected monthly sync response.");
    }

    lastSuccessfulSyncAtRef.current = Date.now();
    applySynchronizedSnapshot(monthResponse.result, currentMonthReadToken);
    if (loadedHistoricalMonths.length > 0) {
      const refreshedHistory = await Promise.all(
        loadedHistoricalMonths.map(async (month) => {
          const readToken = beginMonthRead(month);
          const response = await sendRequest({
            type: "messages/read-month",
            month,
          });
          if (!response.ok || response.type !== "messages/month") {
            throw new Error(
              "OneDrop received an unexpected history synchronization response.",
            );
          }
          return { result: response.result, readToken };
        }),
      );
      for (const { result, readToken } of refreshedHistory) {
        applySynchronizedSnapshot(result, readToken);
      }
    }
    if (runArchiveMaintenance) {
      void checkArchiveTasks();
      void sendRequest({ type: "files/check-cleanup" }).catch(() => undefined);
    }
    if (restoreTransfers) {
      void Promise.all([
        restorePendingFiles(monthResponse.result),
        restorePendingTexts(monthResponse.result),
      ]).catch(() => undefined);
    }
    lastSuccessfulSyncAtRef.current = Date.now();
  }

  async function checkArchiveTasks() {
    try {
      const response = await sendRequest({ type: "archives/check" });
      if (response.ok && response.type === "archives/notices") {
        setArchiveNotices((current) => {
          const currentMonths = new Set(current.map((notice) => notice.month));
          return [
            ...response.notices.filter(
              (notice) => !currentMonths.has(notice.month),
            ),
            ...current,
          ];
        });
      }
    } catch {
      // Archive maintenance never changes the foreground sync result.
    }
  }

  function updateArchiveNotice(notice: ArchiveNotice) {
    setArchiveNotices((current) => [
      ...current.filter((item) => item.month !== notice.month),
      notice,
    ]);
  }

  async function retryArchive(month: string) {
    updateArchiveNotice({ month, phase: "running" });
    try {
      const response = await sendRequest({ type: "archives/retry", month });
      if (response.ok && response.type === "archives/notice") {
        if (response.notice) updateArchiveNotice(response.notice);
        else
          setArchiveNotices((current) =>
            current.filter((notice) => notice.month !== month),
          );
      }
    } catch {
      updateArchiveNotice({ month, phase: "failed" });
    }
  }

  async function dismissArchiveNotice(month: string) {
    setArchiveNotices((current) =>
      current.filter((notice) => notice.month !== month),
    );
    try {
      await sendRequest({ type: "archives/dismiss", month });
    } catch {
      // Dismissing the foreground card must not affect archive maintenance.
    }
  }

  async function run(request: RuntimeRequest) {
    setIsWorking(true);
    setError(undefined);

    try {
      const nextStatus = await sendAuthRequest(request);
      setStatus(nextStatus);
      setMonthResult(undefined);
      setHistoricalMonthResults([]);
      historyCursorRef.current = undefined;

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
      await loadOneDriveState(true, true, false);
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
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    setError(undefined);
    setDismissedNoticeKeys(new Set());
    try {
      await loadOneDriveState(false);
      setAttachmentCheckVersion((version) => version + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "OneDrive refresh failed",
      );
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }

  async function syncCurrentMonthSilently() {
    if (syncInFlightRef.current || status?.state !== "signed-in") return;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    const readToken = beginMonthRead(getUtcMonth());
    try {
      const response = await sendRequest({
        type: "messages/read-current-month",
      });
      if (!response.ok || response.type !== "messages/month") return;
      applySynchronizedSnapshot(response.result, readToken);
      const refreshedHistory = await Promise.all(
        historicalMonthResults.map(async ({ month }) => {
          const historicalReadToken = beginMonthRead(month);
          const historicalResponse = await sendRequest({
            type: "messages/read-month",
            month,
          });
          if (
            !historicalResponse.ok ||
            historicalResponse.type !== "messages/month"
          ) {
            throw new Error("Unexpected historical synchronization response.");
          }
          return {
            result: historicalResponse.result,
            readToken: historicalReadToken,
          };
        }),
      );
      for (const historical of refreshedHistory) {
        applySynchronizedSnapshot(historical.result, historical.readToken);
      }
      lastSuccessfulSyncAtRef.current = Date.now();
    } catch {
      // Automatic foreground synchronization is best effort. The explicit
      // sync button remains available when the connection recovers.
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }

  async function refreshUploadingMessage(messageId: string) {
    setRefreshingUploadIds((current) => new Set(current).add(messageId));
    try {
      const readToken = beginMonthRead(getUtcMonth());
      const response = await sendRequest({
        type: "messages/read-current-month",
      });
      if (!response.ok || response.type !== "messages/month") return;
      if (
        !shouldApplyMonthRead(
          readToken,
          readRequestVersionsRef.current.get(response.result.month),
          localOperationVersionsRef.current.get(response.result.month) ?? 0,
          activeLocalWritesRef.current.get(response.result.month) ?? 0,
        )
      ) {
        return;
      }
      const refreshedResult = response.result;
      if (refreshedResult.state !== "loaded") return;
      const refreshedMessage = refreshedResult.messages.find(
        (message) => message.id === messageId,
      );

      setMonthResult((current) => {
        if (!current || current.state !== "loaded") return current;
        return {
          ...current,
          messages: refreshedMessage
            ? current.messages.map((message) =>
                message.id === messageId ? refreshedMessage : message,
              )
            : current.messages.filter((message) => message.id !== messageId),
        };
      });
      if (!refreshedMessage || refreshedMessage.type !== "file-uploading") {
        setUnresponsiveUploadIds((current) => {
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      }
    } finally {
      setRefreshingUploadIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }

  async function openOneDropFolder() {
    setIsAccountOpen(false);
    setError(undefined);
    try {
      const response = await sendRequest({ type: "onedrive/open-app-folder" });
      if (!response.ok || response.type !== "onedrive/app-folder-opened") {
        throw new Error("OneDrop could not open its OneDrive folder.");
      }
    } catch (cause) {
      setError(getClientError(cause));
    }
  }

  async function cleanDeletedData() {
    setShowDeletedDataCleanupConfirmation(false);
    setIsAccountOpen(false);
    setDeletedDataCleanupNotice(undefined);
    setIsDeletedDataCleanupRunning(true);
    try {
      const response = await sendRequest({ type: "deleted-data/clean-now" });
      if (!response.ok) throw new Error(response.error);
      if (response.type !== "deleted-data/cleaned") {
        throw new Error("OneDrop received an unexpected cleanup response.");
      }
      setDeletedDataCleanupNotice({
        phase: "succeeded",
        messages: response.messages,
        attachments: response.attachments,
      });
    } catch (cause) {
      setDeletedDataCleanupNotice({
        phase: "failed",
        error: getClientError(cause),
      });
    } finally {
      setIsDeletedDataCleanupRunning(false);
    }
  }

  async function synchronizeCurrentMonthSnapshot(): Promise<void> {
    const month = getUtcMonth();
    const readToken = beginMonthRead(month);
    const response = await sendRequest({ type: "messages/read-current-month" });
    if (!response.ok || response.type !== "messages/month") {
      throw new Error("OneDrop could not reread the record file.");
    }
    applySynchronizedSnapshot(response.result, readToken);
  }

  async function retryNotice(noticeKey: string) {
    setIsWorking(true);
    setProcessingNoticeKey(noticeKey);
    setError(undefined);
    try {
      await synchronizeCurrentMonthSnapshot();
    } catch (cause) {
      setError(getClientError(cause));
    } finally {
      setIsWorking(false);
      setProcessingNoticeKey(undefined);
    }
  }

  async function deleteCorruptFile(itemId: string) {
    const noticeKey = `corrupt:${itemId}`;
    setIsWorking(true);
    setProcessingNoticeKey(noticeKey);
    setError(undefined);
    try {
      const deleted = await sendRequest({
        type: "messages/delete-corrupt-file",
        itemId,
      });
      if (!deleted.ok || deleted.type !== "messages/corrupt-file-deleted") {
        throw new Error("OneDrop could not delete the damaged record file.");
      }
      await synchronizeCurrentMonthSnapshot();
    } catch (cause) {
      setError(getClientError(cause));
    } finally {
      setIsWorking(false);
      setProcessingNoticeKey(undefined);
    }
  }

  async function openCorruptFileLocation(itemId: string) {
    if (openingRecordItemId) return;
    setOpeningRecordItemId(itemId);
    setRecordLocationError(undefined);
    try {
      const response = await sendRequest({
        type: "messages/open-corrupt-file-location",
        itemId,
      });
      if (
        !response.ok ||
        response.type !== "messages/corrupt-file-location-opened"
      ) {
        throw new Error("OneDrop could not open the record location.");
      }
    } catch {
      setRecordLocationError(
        "OneDrop couldn't open the OneDrive folder. Check your connection and try again.",
      );
    } finally {
      setOpeningRecordItemId(undefined);
    }
  }

  async function resolveConflict(messageId: string, keepItemId: string) {
    const noticeKey = `conflict:${messageId}`;
    const finishLocalWrite = beginLocalWrite(getUtcMonth());
    setIsWorking(true);
    setProcessingNoticeKey(noticeKey);
    setError(undefined);
    try {
      const response = await enqueueWrite(() =>
        sendRequest({
          type: "messages/resolve-conflict",
          messageId,
          keepItemId,
        }),
      );
      if (!response.ok || response.type !== "messages/conflict-resolved") {
        throw new Error("OneDrop could not resolve the message conflict.");
      }
      applyWriteSnapshot(response.result);
    } catch (cause) {
      setError(getClientError(cause));
    } finally {
      finishLocalWrite();
      setIsWorking(false);
      setProcessingNoticeKey(undefined);
    }
  }

  async function sendText() {
    if (!draft.trim() || isCreatingPendingTextRef.current) {
      return;
    }

    isCreatingPendingTextRef.current = true;
    setIsCreatingPendingText(true);
    const pending: PendingText = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      text: draft.trim(),
      status: "sending",
    };
    try {
      await putPendingText(pending);
      setPendingTexts((items) => [...items, pending]);
      setDraft("");
    } finally {
      isCreatingPendingTextRef.current = false;
      setIsCreatingPendingText(false);
    }
    void sendPendingText(pending);
  }

  async function sendPendingText(pending: PendingText) {
    if (activePendingTextWriteIdsRef.current.has(pending.id)) return;
    const finishLocalWrite = beginLocalWrite(getUtcMonth());
    activePendingTextWriteIdsRef.current.add(pending.id);
    setSendingTextIds((ids) => new Set(ids).add(pending.id));
    setError(undefined);
    const sentAt = new Date().toISOString();
    try {
      await updatePendingText(pending.id, { status: "sending" });
      setPendingTexts((items) =>
        items.map((item) =>
          item.id === pending.id ? { ...item, status: "sending" } : item,
        ),
      );
      const response = await enqueueWrite(() =>
        sendRequest({
          type: "messages/send-text",
          text: pending.text,
          messageId: pending.id,
          createdAt: sentAt,
        }),
      );

      if (!response.ok || response.type !== "messages/month") {
        throw new Error("OneDrop received an unexpected send response.");
      }

      applyWriteSnapshot(response.result);
      forceScrollToBottomRef.current = true;
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
      finishLocalWrite();
      activePendingTextWriteIdsRef.current.delete(pending.id);
      setSendingTextIds((ids) => {
        const next = new Set(ids);
        next.delete(pending.id);
        return next;
      });
    }
  }

  async function deleteTimelineMessage(messageId: string, month: string) {
    if (deletingMessageIds.has(messageId)) return;
    setDeletingMessageIds((ids) => new Set(ids).add(messageId));
    const cloudResult =
      month === getUtcMonth()
        ? monthResult
        : historicalMonthResults.find((result) => result.month === month);
    const removedCloudMessage =
      cloudResult?.state === "loaded"
        ? cloudResult.messages.find((message) => message.id === messageId)
        : undefined;
    const removedPendingText = pendingTexts.find(
      (item) => item.id === messageId,
    );
    const removedPendingFile = pendingFiles.find(
      (item) => item.id === messageId,
    );
    const existsInCloudResult =
      cloudResult?.state === "loaded" &&
      cloudResult.messages.some((message) => message.id === messageId);
    const hasActivePendingWrite =
      removedPendingText?.status === "sending" ||
      removedPendingFile?.status === "uploading" ||
      removedPendingFile?.status === "committing";
    const isLocalOnlyPending =
      !existsInCloudResult &&
      !hasActivePendingWrite &&
      (pendingTexts.some((item) => item.id === messageId) ||
        pendingFiles.some((item) => item.id === messageId));
    const timeline = timelineScrollRef.current;
    if (timeline) {
      if (initialBottomFrameRef.current !== undefined) {
        cancelAnimationFrame(initialBottomFrameRef.current);
        initialBottomFrameRef.current = undefined;
      }
      isApplyingBottomScrollRef.current = false;
      preservedTimelineViewportRef.current = {
        scrollTop: timeline.scrollTop,
        scrollHeight: timeline.scrollHeight,
      };
      shouldStickToBottomRef.current = false;
    }
    setOptimisticallyDeletedMessageIds((ids) => new Set(ids).add(messageId));
    setPendingDeleteMessage(undefined);
    const removeFromResult = (current: MonthReadResult): MonthReadResult => {
      if (current.state !== "loaded") return current;
      const { messageConflicts, ...rest } = current;
      return {
        ...rest,
        messages: current.messages.filter(
          (message) => message.id !== messageId,
        ),
        ...(messageConflicts
          ? {
              messageConflicts: messageConflicts.filter(
                (conflict) => conflict.messageId !== messageId,
              ),
            }
          : {}),
      };
    };
    if (month === getUtcMonth()) {
      setMonthResult((current) =>
        current ? removeFromResult(current) : current,
      );
    } else {
      setHistoricalMonthResults((results) =>
        results.map((result) =>
          result.month === month ? removeFromResult(result) : result,
        ),
      );
    }
    setPendingTexts((items) => items.filter((item) => item.id !== messageId));
    setPendingFiles((items) => items.filter((item) => item.id !== messageId));
    if (isLocalOnlyPending) {
      await Promise.all([
        deletePendingText(messageId),
        deletePendingTransfer(messageId),
      ]);
      if (removedPendingFile?.previewUrl) {
        URL.revokeObjectURL(removedPendingFile.previewUrl);
      }
      setDeletingMessageIds((ids) => {
        const next = new Set(ids);
        next.delete(messageId);
        return next;
      });
      return;
    }
    setError(undefined);
    const finishLocalWrite = beginLocalWrite(month);
    try {
      const response = await enqueueWrite(() =>
        sendRequest({
          type: "messages/delete",
          messageId,
          month,
        }),
      );
      if (!response.ok || response.type !== "messages/deleted") {
        throw new Error("OneDrop received an unexpected delete response.");
      }
      applyWriteSnapshot(response.result, messageId);
      await Promise.all([
        deletePendingText(messageId),
        deletePendingTransfer(messageId),
      ]);
      if (removedPendingFile?.previewUrl) {
        URL.revokeObjectURL(removedPendingFile.previewUrl);
      }
    } catch (cause) {
      setOptimisticallyDeletedMessageIds((ids) => {
        const next = new Set(ids);
        next.delete(messageId);
        return next;
      });
      if (removedCloudMessage) {
        const restoreMessage = (result: MonthReadResult): MonthReadResult => {
          if (result.state !== "loaded") return result;
          if (result.messages.some((message) => message.id === messageId)) {
            return result;
          }
          return {
            ...result,
            messages: [...result.messages, removedCloudMessage].sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                left.id.localeCompare(right.id),
            ),
          };
        };
        if (month === getUtcMonth()) {
          setMonthResult((current) =>
            current ? restoreMessage(current) : current,
          );
        } else {
          setHistoricalMonthResults((results) =>
            results.map((result) =>
              result.month === month ? restoreMessage(result) : result,
            ),
          );
        }
      }
      setError(getClientError(cause));
    } finally {
      finishLocalWrite();
      setDeletingMessageIds((ids) => {
        const next = new Set(ids);
        next.delete(messageId);
        return next;
      });
    }
  }

  function handleTimelineScroll() {
    const timeline = timelineScrollRef.current;
    if (timeline && !isApplyingBottomScrollRef.current) {
      shouldStickToBottomRef.current =
        timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2;
    }
    setIsTimelineScrolling(true);
    scheduleScrollbarHide();
    if (!isSyncing && (timelineScrollRef.current?.scrollTop ?? 1) <= 24) {
      void loadPreviousMonth();
    }
  }

  async function loadPreviousMonth() {
    if (historyLoadingRef.current || !monthResult) return;
    const oldestMonth =
      historyCursorRef.current ??
      historicalMonthResults[0]?.month ??
      monthResult.month;
    const month = getPreviousMonth(oldestMonth);
    historyLoadingRef.current = true;
    setIsLoadingHistory(true);
    setError(undefined);
    historyScrollHeightRef.current = timelineScrollRef.current?.scrollHeight;
    try {
      const readToken = beginMonthRead(month);
      const response = await sendRequest({
        type: "messages/read-month",
        month,
      });
      if (!response.ok || response.type !== "messages/month") {
        throw new Error("OneDrop received an unexpected history response.");
      }
      if (
        !shouldApplyMonthRead(
          readToken,
          readRequestVersionsRef.current.get(month),
          localOperationVersionsRef.current.get(month) ?? 0,
          activeLocalWritesRef.current.get(month) ?? 0,
        )
      ) {
        historyScrollHeightRef.current = undefined;
        historyLoadingHeightRef.current = 0;
        return;
      }
      historyCursorRef.current = month;
      if (response.result.state !== "missing") {
        setHistoricalMonthResults((results) => [response.result, ...results]);
      } else {
        historyScrollHeightRef.current = undefined;
        historyLoadingHeightRef.current = 0;
      }
    } catch (cause) {
      historyScrollHeightRef.current = undefined;
      historyLoadingHeightRef.current = 0;
      setError(getClientError(cause));
    } finally {
      historyLoadingRef.current = false;
      setIsLoadingHistory(false);
    }
  }

  function handleTimelineMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setIsTimelineScrollbarHovered(event.clientX >= bounds.right - 16);
  }

  function handleTimelineMouseLeave() {
    setIsTimelineScrollbarHovered(false);
  }

  function scheduleScrollbarHide() {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      setIsTimelineScrolling(false);
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
    forceScrollToBottomRef.current = true;
    setScrollRevision((revision) => revision + 1);
    await uploadPendingFile(pending);
  }

  function canAcceptDesktopFileDrop(event: ReactDragEvent<HTMLElement>) {
    return (
      !document.body.classList.contains("mobile-surface") &&
      status?.state === "signed-in" &&
      Boolean(monthResult) &&
      Array.from(event.dataTransfer.types).includes("Files")
    );
  }

  function handleFileDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!canAcceptDesktopFileDrop(event)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsFileDragActive(true);
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!canAcceptDesktopFileDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!canAcceptDesktopFileDrop(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsFileDragActive(false);
  }

  function handleFileDrop(event: ReactDragEvent<HTMLElement>) {
    if (!canAcceptDesktopFileDrop(event)) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setIsFileDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void (async () => {
      for (const file of files) await selectFile(file);
    })();
  }

  async function uploadPendingFile(pending: PendingFile) {
    if (!pending.file) {
      reselectPendingIdRef.current = pending.id;
      fileInputRef.current?.click();
      return;
    }

    const isResend = pending.status !== "uploading";
    const transferCreatedAt = isResend
      ? new Date().toISOString()
      : pending.createdAt;
    cancelledUploadIdsRef.current.delete(pending.id);
    updatePending(pending.id, {
      status: "uploading",
      progress: 0,
      progressTarget: 0,
    });
    if (isResend) await delay(320);

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      updatePending(pending.id, {
        status: "upload-failed",
        error: "You appear to be offline. Reconnect and Resend.",
      });
      return;
    }

    try {
      let base64: string | undefined;
      try {
        if (pending.file.size <= MAX_DIRECT_FILE_BYTES) {
          base64 = await fileToBase64(pending.file);
        }
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
      const finishLocalWrite = beginLocalWrite(getUtcMonth(), false);
      try {
        const response = await sendRequest({
          type: "files/send",
          file: {
            name: pending.file.name,
            mimeType: pending.file.type || "application/octet-stream",
            size: pending.file.size,
            ...(base64 ? { base64 } : {}),
            ...(pending.imageWidth ? { imageWidth: pending.imageWidth } : {}),
            ...(pending.imageHeight
              ? { imageHeight: pending.imageHeight }
              : {}),
            ...(pending.thumbHash ? { thumbHash: pending.thumbHash } : {}),
          },
          messageId: pending.id,
          createdAt: transferCreatedAt,
          ...(isResend ? { reuseExisting: true } : {}),
        });
        handleFileTransferResponse(pending.id, response);
      } finally {
        finishLocalWrite();
      }
    } catch (cause) {
      updatePending(pending.id, {
        status: "upload-failed",
        error: getClientError(cause),
      });
    }
  }

  async function cancelFileUpload(messageId: string) {
    cancelledUploadIdsRef.current.add(messageId);
    updatePending(messageId, {
      status: "cancelled",
      error: "Upload cancelled.",
      progress: 0,
      progressTarget: 0,
    });
    try {
      await sendRequest({ type: "files/cancel", messageId });
    } catch {
      // The local cancelled state is authoritative for this user action.
    }
  }

  async function retryFileCommit(pending: PendingFile) {
    if (!pending.attachment) return;
    const finishLocalWrite = beginLocalWrite(getUtcMonth());
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
    } finally {
      finishLocalWrite();
    }
  }

  async function discardPendingPlaceholder(messageId: string) {
    const finishLocalWrite = beginLocalWrite(getUtcMonth());
    try {
      await sendRequest({
        type: "files/discard-placeholder",
        messageId,
      });
    } catch {
      // The next reconnect or restore pass retries this idempotent cleanup.
    } finally {
      finishLocalWrite();
    }
  }

  function handleFileTransferResponse(id: string, response: RuntimeResponse) {
    if (cancelledUploadIdsRef.current.has(id)) return;
    if (!response.ok || response.type !== "files/transfer") {
      updatePending(id, {
        status: "upload-failed",
        error: "OneDrop received an unexpected file transfer response.",
      });
      return;
    }
    if (response.transfer.state === "sent") {
      applyWriteSnapshot(response.transfer.result);
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
    setPendingFiles((current) => {
      for (const pending of current) {
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
      }
      return restored;
    });
    for (const pending of restored) {
      if (pending.status === "committing" && pending.attachment) {
        void retryFileCommit(pending);
      } else if (pending.status === "upload-failed") {
        void discardPendingPlaceholder(pending.id);
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
    if (draft.trim()) void sendText();
  }

  const showUnifiedLoader =
    !error &&
    (!status || (status.state === "signed-in" && monthResult === undefined));

  return (
    <main
      className="shell"
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
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
              onClick={() => {
                setIsAccountOpen((open) => !open);
                setIsAccountSwitcherOpen(false);
              }}
              type="button"
            >
              <span className="account-avatar" aria-hidden="true">
                {getAccountInitial(status)}
              </span>
              <span className="account-email">
                {status.account.username ?? "Microsoft account"}
              </span>
            </button>
            {isDeletedDataCleanupRunning ? (
              <FloatingErrorTooltip
                className="account-cleanup-tooltip"
                message="Cleaning up deleted data…"
              >
                <span
                  aria-label="Cleaning up deleted data"
                  className="account-cleanup-status"
                  role="status"
                >
                  <CleanupBroomIcon />
                </span>
              </FloatingErrorTooltip>
            ) : null}
            <FloatingErrorTooltip
              className="account-refresh-tooltip"
              message="Sync messages and files"
            >
              <button
                aria-label="Refresh messages and files"
                className="account-refresh"
                disabled={isSyncing || isWorking}
                onClick={() => void refreshTimeline()}
                type="button"
              >
                {isSyncing ? <LoadingIcon /> : <RefreshIcon />}
              </button>
            </FloatingErrorTooltip>
            {isAccountOpen ? (
              <div className="account-popover">
                <div className="account-popover-current">
                  <span className="account-popover-avatar" aria-hidden="true">
                    {getAccountInitial(status)}
                  </span>
                  <span className="account-popover-identity">
                    <strong>
                      {status.account.displayName ?? "Microsoft account"}
                    </strong>
                    <small>
                      {status.account.username ?? "Microsoft account"}
                    </small>
                  </span>
                  <button
                    aria-expanded={isAccountSwitcherOpen}
                    aria-label="Switch account"
                    className="account-switch-toggle"
                    onClick={() => setIsAccountSwitcherOpen((open) => !open)}
                    type="button"
                  >
                    <SwitchAccountIcon />
                  </button>
                </div>

                {isAccountSwitcherOpen ? (
                  <div className="account-switcher">
                    <span className="account-section-label">
                      Switch account
                    </span>
                    <p className="account-switcher-empty">
                      No other signed-in accounts
                    </p>
                    <button
                      className="account-menu-action"
                      disabled
                      type="button"
                    >
                      <AddAccountIcon />
                      <span>Add account</span>
                    </button>
                  </div>
                ) : null}

                <div className="account-menu-section">
                  <button
                    className="account-menu-action"
                    disabled={isWorking}
                    onClick={() => void openOneDropFolder()}
                    type="button"
                  >
                    <FolderIcon />
                    <span>Open OneDrive folder</span>
                  </button>
                  <button
                    className="account-menu-action"
                    disabled
                    type="button"
                  >
                    <RecycleBinIcon />
                    <span>Recycle bin</span>
                    <small>Coming later</small>
                  </button>
                </div>

                <div className="account-menu-section account-menu-footer">
                  <button
                    className="account-menu-action account-popover-signout"
                    disabled={isWorking || isSyncing}
                    onClick={() => void run({ type: "auth/sign-out" })}
                    type="button"
                  >
                    <SignOutIcon />
                    <span>Sign out…</span>
                  </button>
                  <button
                    className="account-menu-action account-menu-cleanup"
                    disabled={isDeletedDataCleanupRunning}
                    onClick={() => setShowDeletedDataCleanupConfirmation(true)}
                    type="button"
                  >
                    {isDeletedDataCleanupRunning ? (
                      <LoadingIcon />
                    ) : (
                      <CleanupBroomIcon />
                    )}
                    <span>
                      {isDeletedDataCleanupRunning
                        ? "Cleaning up…"
                        : "Clean up deleted data"}
                    </span>
                  </button>
                </div>
              </div>
            ) : null}
          </section>
          {notificationCount > 0 ? (
            <div
              aria-label={`Notifications, ${activeNoticeIndex + 1} of ${notificationCount}`}
              className={`notification-stack notification-count-${Math.min(notificationCount, 4)}${isNoticeDragging ? " is-dragging" : ""}${noticeCycleDirection !== null ? ` is-cycling is-cycling-${noticeCycleDirection > 0 ? "forward" : "backward"} is-cycle-motion-${noticeCycleMotion} is-cycle-${noticeCycleGesture}` : ""}`}
              onPointerCancel={() => {
                noticeDragStartYRef.current = null;
                setIsNoticeDragging(false);
                setNoticeDragOffset(0);
              }}
              onPointerDown={handleNotificationPointerDown}
              onPointerMove={handleNotificationPointerMove}
              onPointerUp={handleNotificationPointerUp}
              onWheel={handleNotificationWheel}
              style={
                {
                  "--notification-drag-y": `${noticeDragOffset}px`,
                  "--notification-drag-back-y": `${noticeDragOffset * 0.18}px`,
                } as CSSProperties
              }
            >
              {visibleCorruptFiles.map((file, index) => {
                const noticeKey = `corrupt:${file.itemId}`;
                const isProcessing = processingNoticeKey === noticeKey;
                const depth = getNotificationDepth(
                  index,
                  activeNoticeIndex,
                  notificationCount,
                );
                const cycleTargetIndex =
                  noticeCycleDirection === null
                    ? -1
                    : (activeNoticeIndex +
                        noticeCycleDirection +
                        notificationCount) %
                      notificationCount;
                return (
                  <aside
                    aria-hidden={depth !== 0}
                    className={`corrupt-record-notice record-damage-notice notification-depth-${Math.min(depth, 3)}${index === cycleTargetIndex ? " notification-cycle-target" : ""}${isProcessing ? " notice-processing" : ""}`}
                    inert={depth !== 0}
                    key={noticeKey}
                  >
                    <button
                      aria-label="Remind me later"
                      className="notice-dismiss-button"
                      onClick={() =>
                        setDismissedNoticeKeys((current) => {
                          const next = new Set(current);
                          next.add(noticeKey);
                          return next;
                        })
                      }
                      title="Remind me later"
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                    <div className="corrupt-record-summary">
                      <p className="corrupt-record-title">
                        A message record is damaged and OneDrop could not read
                        its contents.
                      </p>
                      <p className="corrupt-record-detail">
                        Other messages are still available.
                      </p>
                    </div>
                    <div className="corrupt-record-footer">
                      <button
                        className="corrupt-record-link"
                        disabled={openingRecordItemId === file.itemId}
                        onClick={() =>
                          void openCorruptFileLocation(file.itemId)
                        }
                        type="button"
                      >
                        {openingRecordItemId === file.itemId ? (
                          <LoadingIcon />
                        ) : (
                          <span aria-hidden="true">↗</span>
                        )}
                        {file.name}
                      </button>
                      <div className="corrupt-record-actions">
                        <button
                          disabled={isWorking}
                          onClick={() => void retryNotice(noticeKey)}
                          type="button"
                        >
                          I&apos;ve fixed it — check again
                        </button>
                        <button
                          className="corrupt-record-delete"
                          disabled={isWorking}
                          onClick={() => void deleteCorruptFile(file.itemId)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {isProcessing ? <NoticeProcessingOverlay /> : null}
                  </aside>
                );
              })}
              {visibleMessageConflicts.map((conflict, index) => {
                const noticeKey = `conflict:${conflict.messageId}`;
                const isProcessing = processingNoticeKey === noticeKey;
                const depth = getNotificationDepth(
                  corruptNoticeCount + index,
                  activeNoticeIndex,
                  notificationCount,
                );
                const absoluteIndex = corruptNoticeCount + index;
                const cycleTargetIndex =
                  noticeCycleDirection === null
                    ? -1
                    : (activeNoticeIndex +
                        noticeCycleDirection +
                        notificationCount) %
                      notificationCount;
                return (
                  <aside
                    aria-hidden={depth !== 0}
                    className={`corrupt-record-notice message-conflict-notice notification-depth-${Math.min(depth, 3)}${absoluteIndex === cycleTargetIndex ? " notification-cycle-target" : ""}${isProcessing ? " notice-processing" : ""}`}
                    inert={depth !== 0}
                    key={noticeKey}
                  >
                    <button
                      aria-label="Remind me later"
                      className="notice-dismiss-button"
                      onClick={() =>
                        setDismissedNoticeKeys((current) => {
                          const next = new Set(current);
                          next.add(noticeKey);
                          return next;
                        })
                      }
                      title="Remind me later"
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                    <p>A message has conflicting versions:</p>
                    <ul>
                      {conflict.versions.map((version) => (
                        <li key={version.itemId}>
                          <button
                            className="corrupt-record-link"
                            disabled={openingRecordItemId === version.itemId}
                            onClick={() =>
                              void openCorruptFileLocation(version.itemId)
                            }
                            type="button"
                          >
                            {openingRecordItemId === version.itemId ? (
                              <LoadingIcon />
                            ) : (
                              <span aria-hidden="true">↗</span>
                            )}
                            {version.name}
                          </button>{" "}
                          — line {version.line}
                        </li>
                      ))}
                    </ul>
                    <div className="conflict-record-actions">
                      {conflict.versions.map((version) => (
                        <button
                          disabled={isWorking}
                          key={version.itemId}
                          onClick={() =>
                            void resolveConflict(
                              conflict.messageId,
                              version.itemId,
                            )
                          }
                          type="button"
                        >
                          Keep {version.name}
                        </button>
                      ))}
                      <button
                        disabled={isWorking}
                        onClick={() => void retryNotice(noticeKey)}
                        type="button"
                      >
                        I&apos;ve fixed it — check again
                      </button>
                    </div>
                    {isProcessing ? <NoticeProcessingOverlay /> : null}
                  </aside>
                );
              })}
            </div>
          ) : null}
          <section
            aria-busy={isSyncing}
            aria-label="OneDrop messages"
            className="conversation"
          >
            {monthResult ? (
              <>
                <div
                  className={`message-scroll${isTimelineScrolling || isTimelineScrollbarHovered ? " is-scrolling" : ""}`}
                  onMouseLeave={handleTimelineMouseLeave}
                  onMouseMove={handleTimelineMouseMove}
                  onScroll={handleTimelineScroll}
                  onWheel={handleTimelineScroll}
                  ref={timelineScrollRef}
                >
                  <div className="message-content" ref={timelineContentRef}>
                    {isLoadingHistory ? (
                      <span
                        className="history-loading"
                        ref={historyLoadingElementRef}
                      >
                        Loading...
                      </span>
                    ) : null}
                    {historicalMonthResults.map((result) => (
                      <MonthResult
                        attachmentCheckVersion={attachmentCheckVersion}
                        deviceId={deviceId}
                        key={result.month}
                        hiddenMessageIds={optimisticallyDeletedMessageIds}
                        pendingFiles={[]}
                        pendingTexts={[]}
                        result={result}
                        refreshingUploadIds={refreshingUploadIds}
                        sendingTextIds={sendingTextIds}
                        showEmpty={false}
                        compact
                        unresponsiveUploadIds={unresponsiveUploadIds}
                        onCancel={() => undefined}
                        onResend={(item) => void uploadPendingFile(item)}
                        onDelete={(messageId) =>
                          setPendingDeleteMessage({
                            messageId,
                            month: result.month,
                          })
                        }
                        onUploadingRefresh={(messageId) =>
                          void refreshUploadingMessage(messageId)
                        }
                        onTextResend={(item) => void sendPendingText(item)}
                      />
                    ))}
                    <MonthResult
                      attachmentCheckVersion={attachmentCheckVersion}
                      deviceId={deviceId}
                      hiddenMessageIds={optimisticallyDeletedMessageIds}
                      pendingFiles={pendingFiles}
                      pendingTexts={pendingTexts}
                      result={monthResult}
                      refreshingUploadIds={refreshingUploadIds}
                      sendingTextIds={sendingTextIds}
                      unresponsiveUploadIds={unresponsiveUploadIds}
                      onCancel={(messageId) => void cancelFileUpload(messageId)}
                      onResend={(item) => void uploadPendingFile(item)}
                      onDelete={(messageId) =>
                        setPendingDeleteMessage({
                          messageId,
                          month: monthResult.month,
                        })
                      }
                      onUploadingRefresh={(messageId) =>
                        void refreshUploadingMessage(messageId)
                      }
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
                        disabled={isSendingText}
                        onClick={() => void sendText()}
                        type="button"
                      >
                        {isSendingText ? <LoadingIcon /> : <SendIcon />}
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
      {recordLocationError ? (
        <CenteredOperationDialog
          id="record-location-error"
          message={recordLocationError}
          onClose={() => setRecordLocationError(undefined)}
        />
      ) : null}
      {archiveNotices[0] ? (
        <CenteredArchiveNotice
          notice={archiveNotices[0]}
          onClose={() => void dismissArchiveNotice(archiveNotices[0]!.month)}
          onRetry={() => void retryArchive(archiveNotices[0]!.month)}
        />
      ) : null}
      {pendingDeleteMessage ? (
        <CenteredConfirmationDialog
          confirmLabel="Delete"
          id="delete-message-confirmation"
          message="Are you sure you want to delete this message from all devices?"
          onCancel={() => setPendingDeleteMessage(undefined)}
          onConfirm={() =>
            void deleteTimelineMessage(
              pendingDeleteMessage.messageId,
              pendingDeleteMessage.month,
            )
          }
        />
      ) : null}
      {showDeletedDataCleanupConfirmation ? (
        <CenteredConfirmationDialog
          confirmLabel="Clean up"
          id="deleted-data-cleanup-confirmation"
          message="Permanently clean up all deleted messages and attachments now? This bypasses the 10-day recovery period and cannot be undone."
          onCancel={() => setShowDeletedDataCleanupConfirmation(false)}
          onConfirm={() => void cleanDeletedData()}
        />
      ) : null}
      {deletedDataCleanupNotice ? (
        <CenteredDeletedDataCleanupNotice
          notice={deletedDataCleanupNotice}
          onClose={() => setDeletedDataCleanupNotice(undefined)}
          onRetry={() => void cleanDeletedData()}
        />
      ) : null}
      {isFileDragActive ? (
        <div className="file-drop-overlay" role="status">
          <span className="file-drop-icon" aria-hidden="true">
            <PlusIcon />
          </span>
          <strong>Drop to send</strong>
          <span>Files will be uploaded to OneDrop</span>
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
  onCancel = () => undefined,
  onDelete = () => undefined,
  onResend,
}: {
  items: PendingFile[];
  onCancel?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onResend: (item: PendingFile) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ol className="pending-file-list" aria-label="Pending file transfers">
      {items.map((item) => (
        <li key={item.id}>
          <PendingFileItem
            item={item}
            onCancel={onCancel}
            onDelete={onDelete}
            onResend={onResend}
          />
        </li>
      ))}
    </ol>
  );
}

function PendingFileItem({
  item,
  onCancel,
  onDelete,
  onResend,
}: {
  item: PendingFile;
  onCancel: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onResend: (item: PendingFile) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [displayProgress, setDisplayProgress] = useState(item.progress ?? 0);
  const totalBytes = item.file?.size ?? item.attachment?.size ?? 0;
  const predictionRateRef = useRef(
    totalBytes > 0
      ? ((item.averageUploadBytesPerSecond ?? DEFAULT_UPLOAD_BYTES_PER_SECOND) /
          totalBytes) *
          100
      : 0,
  );
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const isActive = item.status === "uploading" || item.status === "committing";
  const isCancelled = item.status === "cancelled";
  const visibleProgress = Math.floor(displayProgress);

  useEffect(() => {
    if (item.progress === 0) {
      predictionRateRef.current =
        totalBytes > 0
          ? ((item.averageUploadBytesPerSecond ??
              DEFAULT_UPLOAD_BYTES_PER_SECOND) /
              totalBytes) *
            100
          : 0;
      setDisplayProgress(0);
    }
  }, [item.averageUploadBytesPerSecond, item.progress, totalBytes]);

  useEffect(() => {
    if (item.averageUploadBytesPerSecond && totalBytes > 0) {
      predictionRateRef.current =
        (item.averageUploadBytesPerSecond / totalBytes) * 100;
    }
  }, [item.averageUploadBytesPerSecond, totalBytes]);

  useEffect(() => {
    if (item.status !== "uploading") return;
    const confirmed = item.progress ?? 0;
    const target = Math.max(confirmed, item.progressTarget ?? confirmed);
    let previousTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsedSeconds = Math.min((now - previousTick) / 1_000, 0.2);
      previousTick = now;
      setDisplayProgress((current) => {
        if (current < confirmed) {
          const gap = confirmed - current;
          const catchUpRate = Math.max(predictionRateRef.current * 5, gap * 3);
          return Math.min(confirmed, current + catchUpRate * elapsedSeconds);
        }
        if (target <= confirmed) return confirmed;
        const upperLimit = Math.max(confirmed, target - 0.1);
        if (current >= upperLimit) return upperLimit;
        const slowdownPoint = confirmed + (target - confirmed) * 0.7;
        const baseRate = predictionRateRef.current;
        const rate =
          current < slowdownPoint
            ? baseRate
            : baseRate *
              Math.pow(
                Math.max(0, (target - current) / (target - slowdownPoint)),
                2,
              );
        return Math.min(upperLimit, current + rate * elapsedSeconds);
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [item.progress, item.progressTarget, item.status]);

  function retryTransfer() {
    setIsMenuOpen(false);
    onResend(item);
  }

  return (
    <div className="pending-transfer-row">
      {!isActive ? (
        <span className="pending-primary-actions">
          <button
            className="pending-retry-button"
            onClick={retryTransfer}
            type="button"
          >
            <RetryIcon />
            Resend
          </button>
          <button
            aria-expanded={isMenuOpen}
            aria-label="More transfer actions"
            className="pending-more-button"
            onClick={() => setIsMenuOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            <span aria-hidden="true">•••</span>
          </button>
        </span>
      ) : null}
      <FloatingActionsMenu
        anchorRef={menuButtonRef}
        className="pending-actions-menu"
        isOpen={isMenuOpen}
        onDismiss={() => setIsMenuOpen(false)}
        preferredPlacement="above"
        preferredSide="left"
      >
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
        <button
          onClick={() => {
            setIsMenuOpen(false);
            onDelete(item.id);
          }}
          role="menuitem"
          type="button"
        >
          Delete
        </button>
      </FloatingActionsMenu>
      {isActive ? (
        <span className="pending-transfer-active-controls">
          <span className="pending-transfer-spinner">
            {visibleProgress > 0 ? (
              <UploadProgressRing progress={displayProgress} />
            ) : (
              <LoadingIcon />
            )}
          </span>
          {item.status === "uploading" &&
          (item.file?.size ?? item.attachment?.size ?? 0) >
            MAX_DIRECT_FILE_BYTES ? (
            <button
              aria-label="Cancel upload"
              className="pending-cancel-button"
              onClick={() => onCancel(item.id)}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="cancel-upload-icon"
                viewBox="0 0 20 20"
              >
                <rect height="11.5" rx="2.3" width="11.5" x="4.25" y="4.25" />
              </svg>
            </button>
          ) : null}
        </span>
      ) : (
        <FloatingErrorTooltip
          ariaLabel="Transfer error"
          className="pending-transfer-error"
          message={isCancelled ? "Upload cancelled" : "Upload failed"}
        >
          <span aria-hidden="true">!</span>
        </FloatingErrorTooltip>
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
              <span className="pending-image-error-copy">
                {isCancelled ? "Upload cancelled" : "Upload failed"}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="file-attachment pending-file-attachment">
            <FileTypeIcon
              name={item.file?.name ?? item.attachment?.name ?? "File"}
            />
            <span className="file-attachment-copy">
              <FileAttachmentName
                name={item.file?.name ?? item.attachment?.name ?? "File"}
              />
              <small
                className={isActive ? undefined : "pending-file-error-copy"}
              >
                {isActive
                  ? item.status === "uploading" && item.progress !== undefined
                    ? `${visibleProgress}% · ${formatBytes(item.file?.size ?? item.attachment?.size ?? 0)}`
                    : formatBytes(item.file?.size ?? item.attachment?.size ?? 0)
                  : isCancelled
                    ? "Upload cancelled"
                    : "Upload failed"}
              </small>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function UploadProgressRing({ progress }: { progress: number }) {
  const normalizedProgress = Math.max(0, Math.min(100, progress));
  return (
    <svg
      aria-label="Upload progress"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.floor(normalizedProgress)}
      className="upload-progress-ring"
      role="progressbar"
      viewBox="0 0 20 20"
    >
      <circle className="upload-progress-ring-track" cx="10" cy="10" r="8" />
      <circle
        className="upload-progress-ring-value"
        cx="10"
        cy="10"
        pathLength="100"
        r="8"
        style={{ strokeDashoffset: 100 - normalizedProgress }}
      />
    </svg>
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
  hiddenMessageIds,
  pendingFiles,
  pendingTexts,
  result,
  refreshingUploadIds,
  sendingTextIds,
  unresponsiveUploadIds,
  onCancel,
  onDelete,
  onResend,
  onUploadingRefresh,
  onTextResend,
  showEmpty = true,
  compact = false,
}: {
  attachmentCheckVersion: number;
  deviceId: string | undefined;
  hiddenMessageIds: Set<string>;
  pendingFiles: PendingFile[];
  pendingTexts: PendingText[];
  result: MonthReadResult;
  refreshingUploadIds: Set<string>;
  sendingTextIds: Set<string>;
  unresponsiveUploadIds: Set<string>;
  onCancel: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onResend: (item: PendingFile) => void;
  onUploadingRefresh: (messageId: string) => void;
  onTextResend: (item: PendingText) => void;
  showEmpty?: boolean;
  compact?: boolean;
}) {
  const timelineGroups = groupTimelineItems(
    result.state === "loaded"
      ? result.messages.filter((message) => !hiddenMessageIds.has(message.id))
      : [],
    pendingFiles,
    deviceId,
    pendingTexts,
  );

  return (
    <div
      className={`month-result${compact ? " month-result-compact" : ""}`}
      data-timeline-month={result.month}
      aria-live="polite"
    >
      {timelineGroups.length === 0 && showEmpty ? (
        <span className="empty-timeline">No messages yet</span>
      ) : timelineGroups.length > 0 ? (
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
                      onCancel={onCancel}
                      onDelete={onDelete}
                      onResend={onResend}
                    />
                  ) : item.kind === "pending-text" ? (
                    <PendingTextItem
                      isSending={sendingTextIds.has(item.pending.id)}
                      item={item.pending}
                      key={item.pending.id}
                      onDelete={onDelete}
                      onResend={onTextResend}
                    />
                  ) : item.message.type === "file-uploading" ? (
                    <UploadingFileMessageItem
                      isOwn={group.isOwn}
                      key={item.message.id}
                      message={item.message}
                      onDelete={() => onDelete(item.message.id)}
                      isRefreshing={refreshingUploadIds.has(item.message.id)}
                      onRefresh={() => onUploadingRefresh(item.message.id)}
                      unresponsive={
                        unresponsiveUploadIds.has(item.message.id) ||
                        Date.now() -
                          new Date(item.message.createdAt).getTime() >=
                          120_000
                      }
                    />
                  ) : (
                    <CommittedMessageItem
                      checkVersion={attachmentCheckVersion}
                      isOwn={group.isOwn}
                      key={item.message.id}
                      message={item.message}
                      onDelete={() => onDelete(item.message.id)}
                    />
                  ),
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function PendingTextItem({
  isSending,
  item,
  onDelete,
  onResend,
}: {
  isSending: boolean;
  item: PendingText;
  onDelete: (messageId: string) => void;
  onResend: (item: PendingText) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [lineLayout, setLineLayout] = useState<"one" | "two" | "many">("many");
  const [forcedBreakAt, setForcedBreakAt] = useState<number>();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  async function copyText() {
    await navigator.clipboard.writeText(item.text);
    setIsMenuOpen(false);
  }

  useLayoutEffect(() => {
    const text = textRef.current;
    const bubble = bubbleRef.current;
    const row = rowRef.current;
    const container = row?.parentElement;
    if (!text || !bubble || !container) return;
    const measure = () => {
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return;

      const textStyle = getComputedStyle(text);
      const bubbleStyle = getComputedStyle(bubble);
      const horizontalBubbleSpace =
        Number.parseFloat(bubbleStyle.paddingLeft) +
        Number.parseFloat(bubbleStyle.paddingRight) +
        Number.parseFloat(bubbleStyle.borderLeftWidth) +
        Number.parseFloat(bubbleStyle.borderRightWidth);
      const oneLineTextWidth =
        Math.min(containerWidth * 0.84, containerWidth - 122) -
        horizontalBubbleSpace;
      const regularTextWidth =
        Math.min(containerWidth * 0.84, containerWidth - 104) -
        horizontalBubbleSpace;
      const probe = text.cloneNode(true) as HTMLParagraphElement;
      Object.assign(probe.style, {
        position: "fixed",
        inset: "0 auto auto 0",
        zIndex: "-1",
        margin: "0",
        visibility: "hidden",
        maxWidth: "none",
        font: textStyle.font,
        letterSpacing: textStyle.letterSpacing,
        lineHeight: textStyle.lineHeight,
      });
      document.body.append(probe);

      probe.textContent = item.text;
      probe.style.width = "max-content";
      probe.style.whiteSpace = "pre";
      probe.style.overflowWrap = "normal";
      const fitsOneLine =
        !item.text.includes("\n") && probe.scrollWidth <= oneLineTextWidth;
      if (fitsOneLine) {
        probe.remove();
        setForcedBreakAt(undefined);
        setLineLayout("one");
        return;
      }

      probe.textContent = item.text;
      probe.style.width = `${Math.max(1, regularTextWidth)}px`;
      probe.style.whiteSpace = "pre-wrap";
      probe.style.overflowWrap = "anywhere";
      const lineHeight = Number.parseFloat(textStyle.lineHeight);
      const lines = Math.max(1, Math.round(probe.scrollHeight / lineHeight));

      if (lines === 1) {
        const characters = Array.from(item.text);
        let low = 1;
        let high = characters.length - 1;
        let breakAt = 1;
        probe.style.width = "max-content";
        probe.style.whiteSpace = "pre";
        probe.style.overflowWrap = "normal";
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          probe.textContent = characters.slice(0, middle).join("");
          if (probe.scrollWidth <= oneLineTextWidth) {
            breakAt = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        const precedingText = characters.slice(0, breakAt).join("");
        const whitespaceIndex = Math.max(
          precedingText.lastIndexOf(" "),
          precedingText.lastIndexOf("\t"),
        );
        setForcedBreakAt(whitespaceIndex > 0 ? whitespaceIndex + 1 : breakAt);
        probe.remove();
        setLineLayout("two");
        return;
      }

      probe.remove();
      setForcedBreakAt(undefined);
      setLineLayout(lines === 2 ? "two" : "many");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [item.text]);

  return (
    <div className={`pending-text-row pending-text-${lineLayout}`} ref={rowRef}>
      <div className="message-bubble pending-text-bubble" ref={bubbleRef}>
        <p ref={textRef}>
          <LinkifiedMessageText
            forcedBreakAt={forcedBreakAt}
            text={item.text}
          />
        </p>
      </div>
      <span className="pending-text-primary-actions">
        <button
          className="pending-retry-button"
          disabled={isSending}
          onClick={() => onResend(item)}
          type="button"
        >
          {isSending ? <LoadingIcon /> : <RetryIcon />}
          Resend
        </button>
        <button
          aria-expanded={isMenuOpen}
          aria-label="More message actions"
          className="pending-more-button"
          onClick={() => setIsMenuOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <span aria-hidden="true">•••</span>
        </button>
      </span>
      {item.status === "send-failed" ? (
        <span className="pending-text-error">
          <AttachmentError message="Upload failed" />
        </span>
      ) : null}
      <FloatingActionsMenu
        anchorRef={menuButtonRef}
        className="pending-actions-menu"
        isOpen={isMenuOpen}
        onDismiss={() => setIsMenuOpen(false)}
        preferredPlacement="above"
        preferredSide="left"
      >
        <button
          disabled={isSending}
          onClick={() => onResend(item)}
          role="menuitem"
          type="button"
        >
          <RetryIcon />
          Resend
        </button>
        <button onClick={() => void copyText()} role="menuitem" type="button">
          Copy
        </button>
        <button
          onClick={() => {
            setIsMenuOpen(false);
            onDelete(item.id);
          }}
          role="menuitem"
          type="button"
        >
          Delete
        </button>
      </FloatingActionsMenu>
    </div>
  );
}

export function UploadingFileMessageItem({
  isRefreshing,
  isOwn,
  message,
  onDelete = () => undefined,
  onRefresh,
  unresponsive,
}: {
  isRefreshing: boolean;
  isOwn: boolean;
  message: UploadingFileMessage;
  onDelete?: () => void;
  onRefresh: () => void;
  unresponsive: boolean;
}) {
  const isImage = message.pendingAttachment.mimeType.startsWith("image/");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className={`message-item-shell ${isOwn ? "message-item-own" : "message-item-peer"}`}
    >
      <div
        className={`message-bubble message-attachment-bubble uploading-message-bubble${isImage ? " message-image-bubble" : ""}${unresponsive ? " unresponsive-message-bubble" : ""}`}
      >
        {isImage ? (
          <div className="image-attachment">
            <ImagePlaceholderState
              kind={unresponsive ? "preview" : "loading"}
              label={
                unresponsive
                  ? "No response"
                  : isOwn
                    ? "Uploading…"
                    : "Receiving…"
              }
            />
          </div>
        ) : (
          <div className="file-attachment">
            <FileTypeIcon name={message.pendingAttachment.name} />
            <span className="file-attachment-copy">
              <FileAttachmentName name={message.pendingAttachment.name} />
              <small className="remote-transfer-copy">
                {unresponsive
                  ? "No response"
                  : isOwn
                    ? "Uploading…"
                    : "Receiving…"}
              </small>
            </span>
          </div>
        )}
        {unresponsive ? (
          <AttachmentError message="No response" />
        ) : (
          <span
            aria-label="File upload in progress"
            className="uploading-message-indicator"
            role="status"
          >
            <LoadingIcon />
          </span>
        )}
      </div>
      {unresponsive ? (
        <span className="message-primary-actions message-primary-actions-ready">
          <button
            aria-label="Refresh this transfer"
            className="message-local-button"
            disabled={isRefreshing}
            onClick={onRefresh}
            type="button"
          >
            {isRefreshing ? <LoadingIcon /> : <RefreshIcon />}
          </button>
          <button
            aria-expanded={isMenuOpen}
            aria-label="More message actions"
            className="message-more-button"
            onClick={() => setIsMenuOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            <span aria-hidden="true">•••</span>
          </button>
        </span>
      ) : null}
      <FloatingActionsMenu
        anchorRef={menuButtonRef}
        className="message-actions-menu"
        isOpen={isMenuOpen}
        onDismiss={() => setIsMenuOpen(false)}
        preferredPlacement="below"
        preferredSide={isOwn ? "left" : "right"}
      >
        <button
          onClick={() => {
            setIsMenuOpen(false);
            onDelete();
          }}
          role="menuitem"
          type="button"
        >
          Delete
        </button>
      </FloatingActionsMenu>
    </div>
  );
}

export function CommittedMessageItem({
  checkVersion,
  isOwn,
  message,
  onDelete = () => undefined,
}: {
  checkVersion: number;
  isOwn: boolean;
  message: ReadyMessage;
  onDelete?: () => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAttachmentWorking, setIsAttachmentWorking] = useState(false);
  const [attachmentOperationError, setAttachmentOperationError] =
    useState<string>();
  const [localDownloadId, setLocalDownloadId] = useState<number | null>();
  const [imagePreviewDataUrl, setImagePreviewDataUrl] = useState<string>();
  const [cloudAvailability, setCloudAvailability] = useState<
    "checking" | "available" | "missing" | "unknown"
  >(message.type === "file" ? "checking" : "unknown");
  const shellRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const isAttachment = message.type === "file";
  const isImage =
    isAttachment && message.attachment.mimeType.startsWith("image/");
  const isCloudChecking = cloudAvailability === "checking";
  const isCloudMissing = cloudAvailability === "missing";
  const attachmentDriveItemId =
    message.type === "file" ? message.attachment.driveItemId : undefined;

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
  }, [attachmentDriveItemId]);

  useEffect(() => {
    if (attachmentDriveItemId) setCloudAvailability("checking");
  }, [attachmentDriveItemId, checkVersion]);

  async function copyText() {
    if (message.type !== "text") return;
    await navigator.clipboard.writeText(message.text);
    setIsMenuOpen(false);
  }

  async function markLocalAttachmentMissing() {
    if (message.type !== "file") return;
    await deleteDownloadRecord(message.attachment.driveItemId);
    setLocalDownloadId(null);
    setAttachmentOperationError(
      "The local file no longer exists. Please download it again.",
    );
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
      } else {
        throw new Error("Unexpected local file response.");
      }
    } catch {
      setAttachmentOperationError(
        saveAs
          ? "Couldn’t save this file."
          : "Download failed. Please try again.",
      );
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
      void (async () => {
        try {
          const [download] = await browser.downloads.search({ id: downloadId });
          const isMissing =
            !download ||
            download.exists === false ||
            download.state === "interrupted";

          if (isMissing) {
            await markLocalAttachmentMissing();
            return;
          }

          await browser.downloads.open(downloadId);
          await markDownloadOpened(message.attachment.driveItemId, undefined);
        } catch {
          await markLocalAttachmentMissing();
        } finally {
          setIsAttachmentWorking(false);
        }
      })();
      return;
    }

    void requestAttachmentDownload(saveAs);
  }

  async function openAttachmentInOneDrive() {
    if (message.type !== "file" || isAttachmentWorking || isCloudMissing)
      return;
    setIsAttachmentWorking(true);
    setIsMenuOpen(false);
    try {
      const response = await sendRequest({
        type: "files/open-in-onedrive",
        driveItemId: message.attachment.driveItemId,
      });
      if (!response.ok || response.type !== "files/onedrive-opened") {
        throw new Error("Unexpected OneDrive response.");
      }
    } catch {
      setAttachmentOperationError("Couldn’t open this file in OneDrive.");
    } finally {
      setIsAttachmentWorking(false);
    }
  }

  async function showAttachmentInFolder() {
    if (
      message.type !== "file" ||
      typeof localDownloadId !== "number" ||
      isAttachmentWorking
    )
      return;
    setIsAttachmentWorking(true);
    setIsMenuOpen(false);
    try {
      const [download] = await browser.downloads.search({
        id: localDownloadId,
      });
      const isMissing =
        !download ||
        download.exists === false ||
        download.state === "interrupted";
      if (isMissing) {
        await markLocalAttachmentMissing();
        return;
      }
      const response = await sendRequest({
        type: "files/show-in-folder",
        downloadId: localDownloadId,
      });
      if (!response.ok || response.type !== "files/folder-shown") {
        throw new Error("Unexpected local folder response.");
      }
      if (!response.exists) {
        await markLocalAttachmentMissing();
      }
    } catch {
      setAttachmentOperationError("Couldn’t show this file in its folder.");
    } finally {
      setIsAttachmentWorking(false);
    }
  }

  async function copyImage() {
    if (!imagePreviewDataUrl) return;
    setIsMenuOpen(false);
    try {
      const pngBlob = await imageDataUrlToPngBlob(imagePreviewDataUrl);
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
    } catch {
      setAttachmentOperationError("Couldn’t copy this image.");
    }
  }

  function handleBubbleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isAttachment || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    runAttachmentAction(false);
  }

  return (
    <div
      className={`message-item-shell ${isOwn ? "message-item-own" : "message-item-peer"}${message.type === "text" ? " message-text-shell" : ""}`}
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
          <p>
            <LinkifiedMessageText text={message.text} />
          </p>
        ) : isImage ? (
          <ImageAttachment
            attachment={message.attachment}
            checkVersion={checkVersion}
            onAvailabilityChange={setCloudAvailability}
            onPreviewChange={setImagePreviewDataUrl}
          />
        ) : (
          <FileAttachment
            attachment={message.attachment}
            checkVersion={checkVersion}
            onAvailabilityChange={setCloudAvailability}
          />
        )}
      </div>
      <span className="message-primary-actions message-primary-actions-ready">
        {message.type === "file" &&
        !isCloudChecking &&
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
          aria-label={
            isCloudChecking
              ? "Checking message actions"
              : "More message actions"
          }
          className={`message-more-button${isCloudChecking ? " message-more-button-checking" : ""}`}
          disabled={isCloudChecking}
          onClick={() => setIsMenuOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <span aria-hidden="true">•••</span>
        </button>
      </span>
      <FloatingActionsMenu
        anchorRef={menuButtonRef}
        className="message-actions-menu"
        isOpen={isMenuOpen}
        onDismiss={() => setIsMenuOpen(false)}
        preferredPlacement="below"
        preferredSide={isOwn ? "left" : "right"}
      >
        {message.type === "file" && !isCloudMissing ? (
          <>
            <button
              onClick={() => runAttachmentAction(false)}
              role="menuitem"
              type="button"
            >
              {localDownloadId === null ? "Download" : "Open"}
            </button>
            {typeof localDownloadId === "number" ? (
              <button
                onClick={() => void openAttachmentInOneDrive()}
                role="menuitem"
                type="button"
              >
                Open in OneDrive
              </button>
            ) : null}
            <button
              onClick={() => runAttachmentAction(true)}
              role="menuitem"
              type="button"
            >
              Save as
            </button>
            {localDownloadId === null ? (
              <button
                onClick={() => void openAttachmentInOneDrive()}
                role="menuitem"
                type="button"
              >
                Open in OneDrive
              </button>
            ) : null}
            {isImage && imagePreviewDataUrl ? (
              <button
                onClick={() => void copyImage()}
                role="menuitem"
                type="button"
              >
                Copy image
              </button>
            ) : null}
            {typeof localDownloadId === "number" ? (
              <button
                onClick={() => void showAttachmentInFolder()}
                role="menuitem"
                type="button"
              >
                Show in folder
              </button>
            ) : null}
          </>
        ) : null}
        {message.type === "text" ? (
          <button onClick={() => void copyText()} role="menuitem" type="button">
            Copy
          </button>
        ) : null}
        <button
          onClick={() => {
            setIsMenuOpen(false);
            onDelete();
          }}
          role="menuitem"
          type="button"
        >
          Delete
        </button>
      </FloatingActionsMenu>
      {attachmentOperationError ? (
        <CenteredOperationDialog
          id={`attachment-operation-error-${message.id}`}
          message={attachmentOperationError}
          onClose={() => setAttachmentOperationError(undefined)}
        />
      ) : null}
    </div>
  );
}

function CenteredOperationDialog({
  id,
  message,
  onClose,
}: {
  id: string;
  message: string;
  onClose: () => void;
}) {
  return createPortal(
    <div
      aria-labelledby={id}
      aria-modal="true"
      className="operation-dialog-backdrop"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="operation-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <p id={id}>{message}</p>
        <button autoFocus onClick={onClose} type="button">
          OK
        </button>
      </div>
    </div>,
    document.body,
  );
}

function CenteredArchiveNotice({
  notice,
  onClose,
  onRetry,
}: {
  notice: ArchiveNotice;
  onClose: () => void;
  onRetry: () => void;
}) {
  const monthLabel = formatArchiveMonth(notice.month);
  const message =
    notice.phase === "failed"
      ? `Couldn't archive the ${monthLabel} message history. Your messages are unaffected.`
      : notice.phase === "running"
        ? `Archiving the ${monthLabel} message history…`
        : `The ${monthLabel} message history has been archived successfully.`;
  return createPortal(
    <div className="centered-notice-layer">
      <aside
        aria-live={notice.phase === "failed" ? "assertive" : "polite"}
        className={`centered-notice centered-archive-notice centered-archive-notice-${notice.phase}`}
      >
        <button
          aria-label="Close"
          className="centered-notice-close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
        <p>{message}</p>
        {notice.phase !== "succeeded" ? (
          <button
            className="centered-notice-action"
            disabled={notice.phase === "running"}
            onClick={onRetry}
            type="button"
          >
            {notice.phase === "running" ? <LoadingIcon /> : null}
            Retry
          </button>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}

function CenteredDeletedDataCleanupNotice({
  notice,
  onClose,
  onRetry,
}: {
  notice: {
    phase: "failed" | "succeeded";
    messages?: number;
    attachments?: number;
    error?: string;
  };
  onClose: () => void;
  onRetry: () => void;
}) {
  const message =
    notice.phase === "failed" ? (
      (notice.error ?? "Cleanup failed. Try again later.")
    ) : notice.messages === 0 ? (
      "There was no remaining deleted OneDrop data to clean up."
    ) : (
      <>
        <span>Deleted data cleanup has completed successfully.</span>
        <span className="deleted-data-cleanup-summary">
          {notice.messages ?? 0} deleted item
          {notice.messages === 1 ? " was" : "s were"} permanently cleaned up,
          including {notice.attachments ?? 0} attachment
          {notice.attachments === 1 ? "" : "s"}.
        </span>
      </>
    );
  return createPortal(
    <div className="centered-notice-layer">
      <aside
        aria-live={notice.phase === "failed" ? "assertive" : "polite"}
        className={`centered-notice centered-deleted-data-notice centered-deleted-data-notice-${notice.phase}`}
      >
        <button
          aria-label="Close"
          className="centered-notice-close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
        <p>{message}</p>
        {notice.phase === "failed" ? (
          <button
            className="centered-notice-action"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}

function CenteredConfirmationDialog({
  confirmLabel,
  id,
  message,
  onCancel,
  onConfirm,
}: {
  confirmLabel: string;
  id: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div
      aria-labelledby={id}
      aria-modal="true"
      className="operation-dialog-backdrop"
      onClick={onCancel}
      role="dialog"
    >
      <div
        className="operation-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <p id={id}>{message}</p>
        <div className="operation-dialog-actions">
          <button autoFocus onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="operation-dialog-danger"
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ImageAttachment({
  attachment,
  checkVersion = 0,
  onAvailabilityChange,
  onPreviewChange,
}: {
  attachment: Attachment;
  checkVersion?: number;
  onAvailabilityChange?: (
    availability: "checking" | "available" | "missing" | "unknown",
  ) => void;
  onPreviewChange?: (dataUrl: string | undefined) => void;
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
        onPreviewChange?.(undefined);
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
          onPreviewChange?.(response.dataUrl);
        } else if (active) {
          onPreviewChange?.(undefined);
          setPreviewFailed(true);
        }
      } catch {
        if (active) {
          onPreviewChange?.(undefined);
          setPreviewFailed(true);
        }
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
    onPreviewChange,
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
      {isMissing || previewFailed ? (
        <AttachmentError
          message={isMissing ? "Not found in OneDrive" : "Preview unavailable"}
        />
      ) : null}
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
          <FileAttachmentName name={attachment.name} />
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
      {isMissing ? <AttachmentError message="Not found in OneDrive" /> : null}
    </>
  );
}

function AttachmentError({ message }: { message: string }) {
  return (
    <FloatingErrorTooltip
      className="attachment-error-control"
      message={message}
    >
      <span aria-label="Attachment error" className="attachment-error">
        !
      </span>
    </FloatingErrorTooltip>
  );
}

function FloatingErrorTooltip({
  ariaLabel,
  children,
  className,
  message,
}: {
  ariaLabel?: string;
  children: ReactNode;
  className: string;
  message: string;
}) {
  const [isRendered, setIsRendered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    if (!isRendered) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;

      const triggerBounds = trigger.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();
      const edgeMargin = 8;
      const gap = 6;
      const topPosition = triggerBounds.top - tooltipBounds.height - gap;
      const bottomPosition = triggerBounds.bottom + gap;
      const fitsAbove = topPosition >= edgeMargin;
      const fitsBelow =
        bottomPosition + tooltipBounds.height <=
        window.innerHeight - edgeMargin;
      const unclampedTop = fitsAbove
        ? topPosition
        : fitsBelow
          ? bottomPosition
          : triggerBounds.top > window.innerHeight / 2
            ? topPosition
            : bottomPosition;
      const unclampedLeft =
        triggerBounds.left + triggerBounds.width / 2 - tooltipBounds.width / 2;

      setPosition({
        left: Math.min(
          Math.max(unclampedLeft, edgeMargin),
          window.innerWidth - tooltipBounds.width - edgeMargin,
        ),
        top: Math.min(
          Math.max(unclampedTop, edgeMargin),
          window.innerHeight - tooltipBounds.height - edgeMargin,
        ),
        ready: true,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isRendered]);

  useEffect(() => {
    if (!isRendered) return;
    const frame = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [isRendered]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const showTooltip = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setPosition((current) => ({ ...current, ready: false }));
    setIsRendered(true);
  };
  const hideTooltip = () => {
    setIsVisible(false);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setIsRendered(false), 130);
  };

  return (
    <>
      <span
        aria-label={ariaLabel}
        className={className}
        onBlur={hideTooltip}
        onFocus={showTooltip}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        ref={triggerRef}
      >
        {children}
      </span>
      {isRendered
        ? createPortal(
            <div
              className={`floating-error-tooltip${isVisible ? " is-visible" : ""}`}
              ref={tooltipRef}
              style={{
                left: position.left,
                top: position.top,
                visibility: position.ready ? "visible" : "hidden",
              }}
            >
              {message}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

type FloatingMenuPlacement = "above" | "below";
type FloatingMenuSide = "left" | "right";

export function getFloatingMenuPosition({
  anchor,
  menuHeight,
  menuWidth,
  preferredPlacement,
  preferredSide,
  viewportHeight,
  viewportWidth,
}: {
  anchor: Pick<DOMRect, "bottom" | "left" | "right" | "top">;
  menuHeight: number;
  menuWidth: number;
  preferredPlacement: FloatingMenuPlacement;
  preferredSide: FloatingMenuSide;
  viewportHeight: number;
  viewportWidth: number;
}): { left: number; top: number } {
  const edgeMargin = 8;
  const gap = 2;
  const leftCandidate = anchor.left - menuWidth - gap;
  const rightCandidate = anchor.right + gap;
  const aboveCandidate = anchor.top - menuHeight - gap;
  const belowCandidate = anchor.bottom + gap;
  const fitsLeft = leftCandidate >= edgeMargin;
  const fitsRight = rightCandidate + menuWidth <= viewportWidth - edgeMargin;
  const fitsAbove = aboveCandidate >= edgeMargin;
  const fitsBelow = belowCandidate + menuHeight <= viewportHeight - edgeMargin;
  const preferredLeft = preferredSide === "left";
  const preferredAbove = preferredPlacement === "above";
  const unclampedLeft = preferredLeft
    ? fitsLeft || !fitsRight
      ? leftCandidate
      : rightCandidate
    : fitsRight || !fitsLeft
      ? rightCandidate
      : leftCandidate;
  const unclampedTop = preferredAbove
    ? fitsAbove || !fitsBelow
      ? aboveCandidate
      : belowCandidate
    : fitsBelow || !fitsAbove
      ? belowCandidate
      : aboveCandidate;

  return {
    left: Math.min(
      Math.max(unclampedLeft, edgeMargin),
      Math.max(edgeMargin, viewportWidth - menuWidth - edgeMargin),
    ),
    top: Math.min(
      Math.max(unclampedTop, edgeMargin),
      Math.max(edgeMargin, viewportHeight - menuHeight - edgeMargin),
    ),
  };
}

function FloatingActionsMenu({
  anchorRef,
  children,
  className,
  isOpen,
  onDismiss,
  preferredPlacement,
  preferredSide,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className: string;
  isOpen: boolean;
  onDismiss: () => void;
  preferredPlacement: FloatingMenuPlacement;
  preferredSide: FloatingMenuSide;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const anchorBounds = anchor.getBoundingClientRect();
      const menuBounds = menu.getBoundingClientRect();
      setPosition({
        ...getFloatingMenuPosition({
          anchor: anchorBounds,
          menuHeight: menuBounds.height,
          menuWidth: menuBounds.width,
          preferredPlacement,
          preferredSide,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
        }),
        ready: true,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, isOpen, preferredPlacement, preferredSide]);

  useEffect(() => {
    if (!isOpen) return;
    const dismissFromPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        anchorRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onDismiss();
    };
    const dismissFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", dismissFromPointer);
    document.addEventListener("keydown", dismissFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissFromPointer);
      document.removeEventListener("keydown", dismissFromKeyboard);
    };
  }, [anchorRef, isOpen, onDismiss]);

  if (!isOpen) return null;
  return createPortal(
    <div
      className={`${className} floating-actions-menu`}
      ref={menuRef}
      role="menu"
      style={{
        bottom: "auto",
        left: position.left,
        right: "auto",
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function FileAttachmentName({ name }: { name: string }) {
  const [isSingleLine, setIsSingleLine] = useState(false);
  const nameRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = nameRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      setIsSingleLine(element.scrollHeight <= lineHeight * 1.25);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [name]);

  return (
    <span
      className={`file-attachment-name${isSingleLine ? " file-name-one-line" : ""}`}
    >
      <strong ref={nameRef}>{name}</strong>
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

async function imageDataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  if (typeof image.decode === "function") {
    await image.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("Image decode failed")),
        { once: true },
      );
    });
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Image conversion failed.");
  return blob;
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
      <path d="M8 4.5 4 7l4 2.5M16 14.5l4 2.5-4 2.5M20 9.3C17.6 2.6 9.2 1.6 4 7M4 14.7c2.4 6.7 10.8 7.7 16 2.3" />
    </svg>
  );
}

function SwitchAccountIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 6.5h10.5m-2.8-2.8 2.8 2.8-2.8 2.8M16 13.5H5.5m2.8 2.8-2.8-2.8 2.8-2.8" />
    </svg>
  );
}

function AddAccountIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="7.5" cy="7" r="2.7" />
      <path d="M2.8 15c.7-2.5 2.3-3.8 4.7-3.8s4 1.3 4.7 3.8M15 5v5m-2.5-2.5h5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M2.8 5.6h5l1.5 1.7h7.9v7.1a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8V5.6Z" />
      <path d="M2.8 7.3V5.4a1.6 1.6 0 0 1 1.6-1.6h3l1.6 1.8" />
    </svg>
  );
}

function RecycleBinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4.7 6.2h10.6l-.7 10H5.4l-.7-10ZM3.5 6.2h13M7.4 6.2V3.8h5.2v2.4M8 9v4.5m4-4.5v4.5" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M8.3 3.5H4.7a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h3.6M11.2 6.2 15 10l-3.8 3.8M6.8 10H15" />
    </svg>
  );
}

function TestDataIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M7 3.5h6M8 3.5v4l-4.2 7.1a1.3 1.3 0 0 0 1.1 1.9h10.2a1.3 1.3 0 0 0 1.1-1.9L12 7.5v-4M6.1 12h7.8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  );
}

function LoadingIcon() {
  return <span className="loading-spinner" aria-hidden="true" />;
}

const MESSAGE_LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/giu;
const MESSAGE_LINK_TRAILING_PUNCTUATION = /[.,!?;:)\]}>，。！？；：）】》]+$/u;

function LinkifiedMessageText({
  forcedBreakAt,
  text,
}: {
  forcedBreakAt?: number | undefined;
  text: string;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const renderContent = (content: string, start: number): ReactNode => {
    if (
      forcedBreakAt === undefined ||
      forcedBreakAt <= start ||
      forcedBreakAt > start + Array.from(content).length
    ) {
      return content;
    }
    const characters = Array.from(content);
    const offset = forcedBreakAt - start;
    return (
      <>
        {characters.slice(0, offset).join("")}
        <br />
        {characters.slice(offset).join("")}
      </>
    );
  };

  for (const match of text.matchAll(MESSAGE_LINK_PATTERN)) {
    const matchStart = match.index;
    const candidate = match[0];
    const linkText = candidate.replace(MESSAGE_LINK_TRAILING_PUNCTUATION, "");
    if (!linkText) continue;
    if (matchStart > cursor) {
      const plainText = text.slice(cursor, matchStart);
      nodes.push(
        <span key={`text-${key++}`}>
          {renderContent(plainText, Array.from(text.slice(0, cursor)).length)}
        </span>,
      );
    }
    const linkStart = Array.from(text.slice(0, matchStart)).length;
    nodes.push(
      <a
        className="message-text-link"
        href={/^www\./iu.test(linkText) ? `https://${linkText}` : linkText}
        key={`link-${key++}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {renderContent(linkText, linkStart)}
      </a>,
    );
    const trailingText = candidate.slice(linkText.length);
    if (trailingText) {
      nodes.push(
        <span key={`text-${key++}`}>
          {renderContent(trailingText, linkStart + Array.from(linkText).length)}
        </span>,
      );
    }
    cursor = matchStart + candidate.length;
  }

  if (cursor < text.length) {
    nodes.push(
      <span key={`text-${key}`}>
        {renderContent(
          text.slice(cursor),
          Array.from(text.slice(0, cursor)).length,
        )}
      </span>,
    );
  }

  return <>{nodes.length > 0 ? nodes : renderContent(text, 0)}</>;
}

function CleanupBroomIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <g className="cleanup-broom-position">
        <g className="cleanup-broom-sweep">
          <path strokeWidth="1.85" d="M16.1 2.7 11.55 13.15" />
          <path strokeWidth="1.65" d="m10.55 12.2 2.05.9" />
          <path
            strokeWidth="1.75"
            d="m7.7 11.35 7.6 3.32-1.4 3.2-7.6-3.32 1.4-3.2Z"
          />
          <path
            className="cleanup-broom-bristles"
            strokeWidth="1.05"
            d="m6.7 13.65 7.6 3.32m-5.65-4.78-1.3 2.98m3.2-2.15-1.3 2.98m3.2-2.15-1.3 2.98"
          />
        </g>
        <circle className="cleanup-broom-dust" cx="17.2" cy="18.4" r="0.9" />
        <circle
          className="cleanup-broom-dust cleanup-broom-dust-delayed"
          cx="19.7"
          cy="16.7"
          r="0.65"
        />
      </g>
    </svg>
  );
}

function NoticeProcessingOverlay() {
  return (
    <span
      aria-label="Processing notification"
      className="notice-processing-overlay"
      role="status"
    >
      <LoadingIcon />
    </span>
  );
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

function getPreviousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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
