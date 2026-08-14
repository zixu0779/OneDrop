import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type { ArchiveNotice } from "../../contracts/runtime-messages";
import type { MonthDocument } from "../../domain/month-document";
import { getOneDriveRuntime } from "../../platform/onedrive-runtime";
import { readGraphError } from "../graph/graph-error";
import {
  isMonthArchiveEligible,
  publishMonthArchive,
  readMonthArchive,
  readRawMonthArchive,
} from "./month-archive";
import { serializeMonthDocument } from "./month-serialization";
import { readMonthSnapshot } from "./month-reader";

const STORAGE_KEY = "onedrop.archive.tasks.v1";
const TASK_TIMEOUT_MS = 30_000;
const retryDelays = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const;
const finalRetryDelay = 24 * 60 * 60_000;
const runningMonths = new Map<string, Promise<ArchiveNotice | undefined>>();
let schedulerGeneration = 0;

const taskSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  status: z.enum(["cooling-down", "auth-paused", "blocked", "succeeded"]),
  failureCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().datetime().optional(),
  archiveDigest: z.string().optional(),
  cleanupPending: z.boolean().optional(),
  noticeOpen: z.boolean(),
  noticePhase: z.enum(["failed", "running", "succeeded"]).optional(),
});
const storeSchema = z.record(z.string(), taskSchema);
type ArchiveTask = z.infer<typeof taskSchema>;

const childSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  folder: z.object({}).passthrough().optional(),
});
const childrenPageSchema = z.object({
  value: z.array(childSchema),
  "@odata.nextLink": z.string().url().optional(),
});

export async function checkArchiveTasks(): Promise<ArchiveNotice[]> {
  const accessToken = await getOneDriveRuntime().getAccessToken();
  const store = await readStore();
  const months = await listSourceMonths(accessToken);

  for (const month of months) {
    const task = store[month];
    if (task?.status === "succeeded" && task.cleanupPending) {
      void scheduleCleanup(month, task, accessToken);
      return visibleNotices(store);
    }
  }

  const now = Date.now();
  const candidate = months.find((month) => {
    if (!isMonthArchiveEligible(month)) return false;
    const task = store[month];
    if (!task) return true;
    if (
      task.status === "succeeded" ||
      task.status === "blocked" ||
      task.status === "auth-paused"
    )
      return false;
    return !task.nextRetryAt || Date.parse(task.nextRetryAt) <= now;
  });
  if (candidate) void scheduleArchive(candidate, false);
  return visibleNotices(store);
}

export async function retryArchiveTask(
  month: string,
): Promise<ArchiveNotice | undefined> {
  return scheduleArchive(month, true);
}

export async function dismissArchiveNotice(month: string): Promise<void> {
  const store = await readStore();
  const task = store[month];
  if (!task) return;
  await writeTask({ ...task, noticeOpen: false });
}

export async function resetArchiveTasks(): Promise<void> {
  schedulerGeneration += 1;
  runningMonths.clear();
  await getOneDriveRuntime().storage.remove(STORAGE_KEY);
}

export async function resumeArchiveTasksAfterSignIn(): Promise<void> {
  const store = await readStore();
  await writeStore(
    Object.fromEntries(
      Object.entries(store).filter(([, task]) => task.status !== "auth-paused"),
    ),
  );
}

export async function recordRewrittenArchive(
  month: string,
  document: MonthDocument,
): Promise<void> {
  const store = await readStore();
  const task = store[month];
  if (!task || task.status !== "succeeded") return;
  await writeTask({
    ...task,
    archiveDigest: await digestDocument(document),
  });
}

async function scheduleArchive(
  month: string,
  manual: boolean,
): Promise<ArchiveNotice | undefined> {
  const existing = runningMonths.get(month);
  if (existing) return existing;
  const generation = schedulerGeneration;
  const task = runArchive(month, manual, generation).finally(() => {
    if (generation === schedulerGeneration) runningMonths.delete(month);
  });
  runningMonths.set(month, task);
  return task;
}

async function runArchive(
  month: string,
  manual: boolean,
  generation: number,
): Promise<ArchiveNotice | undefined> {
  const store = await readStore();
  const previous = store[month];
  if (previous?.status === "succeeded") return undefined;
  if (!manual && previous?.status === "blocked") return toNotice(previous);
  const showProgress = previous?.noticeOpen === true;
  if (showProgress) {
    const running: ArchiveTask = {
      ...previous,
      noticeOpen: true,
      noticePhase: "running",
    };
    if (generation !== schedulerGeneration) return undefined;
    await writeTask(running);
    await emitNotice(toNotice(running));
  }

  let timeoutReported = false;
  let timeoutReport = Promise.resolve<ArchiveNotice | undefined>(undefined);
  try {
    const accessToken = await getOneDriveRuntime().getAccessToken();
    const result = await waitForArchiveCompletion(
      archiveMonth(month, accessToken),
      () => {
        timeoutReported = true;
        timeoutReport = recordArchiveFailure(
          month,
          previous,
          new Error("Month archive task timed out."),
          generation,
        );
        return timeoutReport;
      },
      TASK_TIMEOUT_MS,
    );
    await timeoutReport;
    if (generation !== schedulerGeneration) return undefined;
    const shouldShowSuccess = showProgress || timeoutReported;
    const succeeded: ArchiveTask = {
      month,
      status: "succeeded",
      failureCount: previous?.failureCount ?? 0,
      archiveDigest: result.digest,
      cleanupPending: true,
      noticeOpen: shouldShowSuccess,
      ...(shouldShowSuccess ? { noticePhase: "succeeded" as const } : {}),
    };
    await writeTask(succeeded);
    const notice = toNotice(succeeded);
    if (notice) await emitNotice(notice);
    return notice;
  } catch (cause) {
    if (generation !== schedulerGeneration) return undefined;
    if (timeoutReported) return timeoutReport;
    return recordArchiveFailure(month, previous, cause, generation);
  }
}

async function recordArchiveFailure(
  month: string,
  previous: ArchiveTask | undefined,
  cause: unknown,
  generation: number,
): Promise<ArchiveNotice | undefined> {
  if (generation !== schedulerGeneration) return undefined;
  const failureCount = (previous?.failureCount ?? 0) + 1;
  const blocked = isBlockingFailure(cause);
  const authPaused = isAuthenticationFailure(cause);
  const failed: ArchiveTask = {
    month,
    status: blocked ? "blocked" : authPaused ? "auth-paused" : "cooling-down",
    failureCount,
    ...(!blocked && !authPaused
      ? {
          nextRetryAt: new Date(
            Date.now() + retryDelay(failureCount),
          ).toISOString(),
        }
      : {}),
    noticeOpen: true,
    noticePhase: "failed",
  };
  await writeTask(failed);
  const notice = toNotice(failed);
  await emitNotice(notice);
  return notice;
}

async function archiveMonth(
  month: string,
  accessToken: string,
): Promise<{ digest: string }> {
  let existing;
  try {
    existing = await readMonthArchive(month, accessToken);
  } catch (cause) {
    if (isAuthenticationFailure(cause)) throw cause;
    throw new ArchiveBlockedError("The existing archive is invalid.", {
      cause,
    });
  }
  const snapshot = await readMonthSnapshot(month, accessToken, true);
  if (snapshot.state === "missing") {
    throw new ArchiveBlockedError("The source month is missing.");
  }
  if ((snapshot.corruptFiles?.length ?? 0) > 0) {
    throw new ArchiveBlockedError("The source month contains damaged files.");
  }
  if ((snapshot.messageConflicts?.length ?? 0) > 0) {
    throw new ArchiveBlockedError("The source month contains conflicts.");
  }
  if (existing) {
    assertDocumentsEqual(existing.document, snapshot.document);
    const raw = await readRawMonthArchive(month, accessToken);
    if (!raw) throw new ArchiveBlockedError("The existing archive is missing.");
    return { digest: await digestDocument(raw.document) };
  }
  const published = await publishMonthArchive(snapshot.document, accessToken);
  return { digest: await digestDocument(published.document) };
}

async function scheduleCleanup(
  month: string,
  task: ArchiveTask,
  accessToken: string,
): Promise<void> {
  if (runningMonths.has(month)) return;
  const generation = schedulerGeneration;
  const cleanup = withTimeout(
    cleanupSourceMonth(month, task, accessToken, generation),
  )
    .catch(() => undefined)
    .finally(() => {
      if (generation === schedulerGeneration) runningMonths.delete(month);
    });
  runningMonths.set(
    month,
    cleanup.then(() => undefined),
  );
}

async function cleanupSourceMonth(
  month: string,
  task: ArchiveTask,
  accessToken: string,
  generation: number,
): Promise<void> {
  const archive = await readRawMonthArchive(month, accessToken);
  if (!archive || !task.archiveDigest) return;
  if ((await digestDocument(archive.document)) !== task.archiveDigest) return;
  await readMonthArchive(month, accessToken);
  const source = await fetch(sourceMonthItemUrl(month), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (source.status === 404) {
    if (generation !== schedulerGeneration) return;
    await writeTask({ ...task, cleanupPending: false });
    return;
  }
  if (!source.ok) throw new Error(await readGraphError(source));
  const item = childSchema.parse(await source.json());
  if (generation !== schedulerGeneration) return;
  const deleted = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!deleted.ok && deleted.status !== 404) {
    throw new Error(await readGraphError(deleted));
  }
  if (generation !== schedulerGeneration) return;
  await writeTask({ ...task, cleanupPending: false });
}

async function listSourceMonths(accessToken: string): Promise<string[]> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages:/children?$select=id,name,folder&$top=200`;
  const months: string[] = [];
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(await readGraphError(response));
    const page = childrenPageSchema.parse(await response.json());
    months.push(
      ...page.value
        .filter((item) => item.folder && /^\d{4}-\d{2}$/u.test(item.name))
        .map((item) => item.name),
    );
    url = page["@odata.nextLink"];
  }
  return months.sort().reverse();
}

async function readStore(): Promise<Record<string, ArchiveTask>> {
  const value = await getOneDriveRuntime().storage.get(STORAGE_KEY);
  return storeSchema.safeParse(value).data ?? {};
}

async function writeTask(task: ArchiveTask): Promise<void> {
  const store = await readStore();
  store[task.month] = task;
  await writeStore(store);
}

async function writeStore(store: Record<string, ArchiveTask>): Promise<void> {
  await getOneDriveRuntime().storage.set(STORAGE_KEY, store);
}

function visibleNotices(store: Record<string, ArchiveTask>): ArchiveNotice[] {
  return Object.values(store)
    .filter((task) => task.noticeOpen)
    .map(toNotice)
    .filter((notice): notice is ArchiveNotice => Boolean(notice));
}

function toNotice(task: ArchiveTask): ArchiveNotice | undefined {
  if (!task.noticeOpen || !task.noticePhase) return undefined;
  return { month: task.month, phase: task.noticePhase };
}

async function emitNotice(notice: ArchiveNotice | undefined): Promise<void> {
  if (!notice) return;
  try {
    await getOneDriveRuntime().emit({ type: "archives/event", notice });
  } catch {
    // The Side Panel may be closed; persisted state is returned on next sync.
  }
}

function retryDelay(failureCount: number): number {
  return retryDelays[failureCount - 1] ?? finalRetryDelay;
}

function isBlockingFailure(cause: unknown): boolean {
  return cause instanceof ArchiveBlockedError;
}

function isAuthenticationFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /access denied|unauthorized|sign in again|session ended|authentication/iu.test(
    message,
  );
}

function assertDocumentsEqual(left: MonthDocument, right: MonthDocument): void {
  if (serializeMonthDocument(left) !== serializeMonthDocument(right)) {
    throw new ArchiveBlockedError(
      "The existing archive differs from its source.",
    );
  }
}

async function digestDocument(document: MonthDocument): Promise<string> {
  const bytes = new TextEncoder().encode(serializeMonthDocument(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Month archive task timed out.")),
          TASK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForArchiveCompletion<T>(
  operation: Promise<T>,
  onTimeout: () => Promise<unknown>,
  timeoutMs: number,
): Promise<T> {
  let timeoutWork = Promise.resolve<unknown>(undefined);
  const timer = setTimeout(() => {
    timeoutWork = onTimeout();
  }, timeoutMs);
  try {
    const result = await operation;
    await timeoutWork;
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function sourceMonthItemUrl(month: string): string {
  return `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages/${month}`;
}

class ArchiveBlockedError extends Error {}
