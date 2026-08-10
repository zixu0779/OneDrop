import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import { tombstoneDocumentSchema } from "../../domain/tombstone";
import type { Message } from "../../domain/message";
import type { CorruptMonthFile } from "../../contracts/runtime-messages";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import { deleteMonthCache } from "../indexed-db/sync-cache";
import { readRawMonthArchive } from "./month-archive";
import { recordRewrittenArchive } from "./archive-scheduler";
import { readMonthSnapshot } from "./month-reader";
import { serializeMonthDocument } from "./month-serialization";

const STORAGE_KEY = "onedrop.deleted-data-cleanup.v2";
const ATTACHMENT_GRACE_PERIOD_MS = 10 * 24 * 60 * 60 * 1_000;
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_ITEMS_PER_SCAN = 20;

const cleanupStateSchema = z.object({
  lastScanAt: z.iso.datetime().optional(),
  completed: z.record(z.string(), z.iso.datetime()).default({}),
});
type CleanupState = z.infer<typeof cleanupStateSchema>;

const childSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  folder: z.object({}).passthrough().optional(),
});
const childrenPageSchema = z.object({
  value: z.array(childSchema),
  "@odata.nextLink": z.string().url().optional(),
});

export type DeletedDataCleanupSummary = {
  messages: number;
  attachments: number;
};

let runningCheck: Promise<DeletedDataCleanupSummary> | undefined;
let cleanupGeneration = 0;
class UnsafeCleanupError extends Error {}
class DeferredCleanupError extends Error {}

export async function checkAttachmentCleanup(
  now = new Date(),
): Promise<number> {
  return (await scheduleCleanup(now, false)).attachments;
}

export async function cleanDeletedDataNow(
  now = new Date(),
): Promise<DeletedDataCleanupSummary> {
  const existing = runningCheck;
  if (existing) {
    try {
      await existing;
    } catch {
      // The manual run below is an explicit retry with no grace or throttle.
    }
  }
  return scheduleCleanup(now, true);
}

function scheduleCleanup(
  now: Date,
  manual: boolean,
): Promise<DeletedDataCleanupSummary> {
  const existing = runningCheck;
  if (existing) return existing;
  const generation = cleanupGeneration;
  const check = runScheduledCheck(now, generation, manual).finally(() => {
    if (runningCheck === check) runningCheck = undefined;
  });
  runningCheck = check;
  return check;
}

export async function resetAttachmentCleanup(): Promise<void> {
  cleanupGeneration += 1;
  runningCheck = undefined;
  await browser.storage.local.remove(STORAGE_KEY);
}

async function runScheduledCheck(
  now: Date,
  generation: number,
  manual: boolean,
): Promise<DeletedDataCleanupSummary> {
  const state = await readState();
  if (
    !manual &&
    state.lastScanAt &&
    now.getTime() - Date.parse(state.lastScanAt) < SCAN_INTERVAL_MS
  ) {
    return { messages: 0, attachments: 0 };
  }

  const accessToken = await getCurrentAccessToken();
  const tombstones = await listTombstones(accessToken);
  assertCurrentGeneration(generation);
  const deletedIdsByMonth = new Map<string, Set<string>>();
  for (const tombstone of tombstones) {
    const ids = deletedIdsByMonth.get(tombstone.originalMonth) ?? new Set();
    ids.add(tombstone.messageId);
    deletedIdsByMonth.set(tombstone.originalMonth, ids);
  }
  let cleanedMessages = 0;
  let cleanedAttachments = 0;
  let inspected = 0;
  for (const tombstone of tombstones) {
    if (!manual && inspected >= MAX_ITEMS_PER_SCAN) break;
    const key = `${tombstone.originalMonth}:${tombstone.messageId}`;
    if (state.completed[key]) continue;
    if (
      !manual &&
      now.getTime() - Date.parse(tombstone.deletedAt) <
        ATTACHMENT_GRACE_PERIOD_MS
    ) {
      continue;
    }
    inspected += 1;
    let result;
    try {
      result = await cleanupTombstonedMessage(
        tombstone.originalMonth,
        tombstone.messageId,
        accessToken,
        deletedIdsByMonth.get(tombstone.originalMonth) ?? new Set(),
        generation,
      );
    } catch (cause) {
      if (cause instanceof DeferredCleanupError) continue;
      if (cause instanceof UnsafeCleanupError && !manual) continue;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Cleanup failed for ${tombstone.originalMonth} message ${tombstone.messageId}: ${detail}`,
        { cause },
      );
    }
    if (result === "unsafe") continue;
    state.completed[key] = now.toISOString();
    cleanedMessages += 1;
    if (result === "deleted") cleanedAttachments += 1;
  }

  state.lastScanAt = now.toISOString();
  assertCurrentGeneration(generation);
  await writeState(state);
  return { messages: cleanedMessages, attachments: cleanedAttachments };
}

async function cleanupTombstonedMessage(
  month: string,
  messageId: string,
  accessToken: string,
  deletedMessageIds: Set<string>,
  generation: number,
): Promise<"deleted" | "absent" | "no-attachment" | "unsafe"> {
  const lookup = await findOriginalMessage(month, messageId, accessToken);
  assertCurrentGeneration(generation);
  if (!lookup.message) {
    if (
      lookup.damagedFiles.length > 0 &&
      (await damagedFilesContainMessage(
        lookup.damagedFiles,
        messageId,
        accessToken,
      ))
    ) {
      return "unsafe";
    }
    await removeTombstone(month, messageId, accessToken, generation);
    return "absent";
  }
  const { message, allMessages } = lookup;
  if (message.createdAt.slice(0, 7) !== month) return "unsafe";

  let attachmentResult: "deleted" | "absent" | "no-attachment" =
    "no-attachment";
  if (message.type === "file") {
    if (
      allMessages.some(
        (other) =>
          other.id !== message.id &&
          !deletedMessageIds.has(other.id) &&
          other.type === "file" &&
          other.attachment.driveItemId === message.attachment.driveItemId,
      )
    ) {
      return "unsafe";
    }
    attachmentResult = await deleteMessageAttachment(
      month,
      message,
      accessToken,
      generation,
    );
  }

  const metadataResult = await removeMessageMetadata(
    month,
    messageId,
    accessToken,
    generation,
  );
  if (metadataResult === "deferred") return "unsafe";
  await removeTombstone(month, messageId, accessToken, generation);
  return attachmentResult;
}

async function deleteMessageAttachment(
  month: string,
  message: Extract<Message, { type: "file" }>,
  accessToken: string,
  generation: number,
): Promise<"deleted" | "absent"> {
  const [year, monthNumber] = month.split("-");
  const folderResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/files/${year}/${monthNumber}/${message.id}?$select=id,folder`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (folderResponse.status === 404) return "absent";
  if (!folderResponse.ok) {
    throw new Error(
      `Attachment cleanup lookup failed: ${await readGraphError(folderResponse)}`,
    );
  }
  const folder = childSchema.parse(await folderResponse.json());
  if (!folder.folder) {
    throw new UnsafeCleanupError("The attachment path is not a folder.");
  }
  if (
    !(await folderContainsDriveItem(
      folder.id,
      message.attachment.driveItemId,
      accessToken,
    ))
  ) {
    return "absent";
  }
  assertCurrentGeneration(generation);

  const deleted = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(folder.id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!deleted.ok && deleted.status !== 404) {
    throw new Error(
      `Attachment cleanup failed: ${await readGraphError(deleted)}`,
    );
  }
  return deleted.status === 404 ? "absent" : "deleted";
}

async function removeMessageMetadata(
  month: string,
  messageId: string,
  accessToken: string,
  generation: number,
): Promise<"removed" | "deferred"> {
  const archive = await readRawMonthArchive(month, accessToken);
  assertCurrentGeneration(generation);
  if (archive) {
    const remaining = archive.document.messages.filter(
      (message) => message.id !== messageId,
    );
    const document =
      remaining.length === archive.document.messages.length
        ? archive.document
        : { ...archive.document, messages: remaining };
    if (document !== archive.document) {
      const response = await fetch(
        `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(archive.itemId)}/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=utf-8",
            "If-Match": archive.eTag,
          },
          body: serializeMonthDocument(document),
        },
      );
      if (response.status === 409 || response.status === 412) {
        throw new Error(
          "The month archive changed during deleted-data cleanup.",
        );
      }
      if (!response.ok) {
        throw new Error(
          `Deleted message cleanup failed: ${await readGraphError(response)}`,
        );
      }
    }
    await recordRewrittenArchive(month, document);
  }

  const snapshot = await readMonthSnapshot(month, accessToken, true);
  if (snapshot.state === "missing") return "removed";
  if (
    snapshot.messageConflicts?.some(
      (conflict) => conflict.messageId === messageId,
    )
  ) {
    throw new DeferredCleanupError(
      "The deleted message still has unresolved conflicting versions.",
    );
  }
  for (const chunk of snapshot.chunks) {
    const remaining = chunk.document.messages.filter(
      (message) => message.id !== messageId,
    );
    if (remaining.length === chunk.document.messages.length) continue;
    assertCurrentGeneration(generation);
    const response = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(chunk.itemId)}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
          "If-Match": chunk.eTag,
        },
        body: serializeMonthDocument({
          ...chunk.document,
          messages: remaining,
        }),
      },
    );
    if (response.status === 409 || response.status === 412) {
      throw new Error("Monthly messages changed during deleted-data cleanup.");
    }
    if (!response.ok) {
      throw new Error(
        `Deleted message cleanup failed: ${await readGraphError(response)}`,
      );
    }
  }
  await deleteMonthCache(month);
  if (
    (snapshot.corruptFiles?.length ?? 0) > 0 &&
    (await damagedFilesContainMessage(
      snapshot.corruptFiles!,
      messageId,
      accessToken,
    ))
  ) {
    return "deferred";
  }
  return "removed";
}

async function damagedFilesContainMessage(
  files: CorruptMonthFile[],
  messageId: string,
  accessToken: string,
): Promise<boolean> {
  for (const file of files) {
    const response = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(file.itemId)}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      throw new Error(
        `Damaged monthly record ${file.name} could not be checked: ${await readGraphError(response)}`,
      );
    }
    if ((await response.text()).includes(messageId)) return true;
  }
  return false;
}

async function removeTombstone(
  month: string,
  messageId: string,
  accessToken: string,
  generation: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const metadata = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/tombstones/${month}.json`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (metadata.status === 404) return;
    if (!metadata.ok) {
      throw new Error(
        `Deletion record cleanup failed: ${await readGraphError(metadata)}`,
      );
    }
    const item = z
      .object({ id: z.string().min(1), eTag: z.string().min(1) })
      .parse(await metadata.json());
    const content = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!content.ok) {
      throw new Error(
        `Deletion record cleanup failed: ${await readGraphError(content)}`,
      );
    }
    const document = tombstoneDocumentSchema.parse(await content.json());
    const tombstones = document.tombstones.filter(
      (tombstone) => tombstone.messageId !== messageId,
    );
    if (tombstones.length === document.tombstones.length) return;
    assertCurrentGeneration(generation);
    const response = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
          "If-Match": item.eTag,
        },
        body: JSON.stringify({ ...document, tombstones }, null, 2),
      },
    );
    if (response.status === 409 || response.status === 412) continue;
    if (!response.ok) {
      throw new Error(
        `Deletion record cleanup failed: ${await readGraphError(response)}`,
      );
    }
    await deleteMonthCache(month);
    return;
  }
  throw new Error("Deletion records changed repeatedly during cleanup.");
}

async function findOriginalMessage(
  month: string,
  messageId: string,
  accessToken: string,
): Promise<{
  message?: Message;
  allMessages: Message[];
  damagedFiles: CorruptMonthFile[];
}> {
  const archive = await readRawMonthArchive(month, accessToken);
  if (archive) {
    const matches = archive.document.messages.filter(
      (message) => message.id === messageId,
    );
    if (matches.length > 0) {
      const message = uniqueMessage(archive.document.messages, messageId);
      if (!message) {
        throw new DeferredCleanupError(
          "Deleted message cleanup found conflicting archive data.",
        );
      }
      return {
        message,
        allMessages: archive.document.messages,
        damagedFiles: [],
      };
    }
  }

  const snapshot = await readMonthSnapshot(month, accessToken, true);
  if (snapshot.state === "missing") {
    return {
      allMessages: [],
      damagedFiles: snapshot.corruptFiles ?? [],
    };
  }
  const allMessages = snapshot.chunks.flatMap(
    (chunk) => chunk.document.messages,
  );
  const matches = allMessages.filter((message) => message.id === messageId);
  const message = uniqueMessage(allMessages, messageId);
  if (matches.length > 0 && !message) {
    throw new DeferredCleanupError(
      "Deleted message cleanup found conflicting source data.",
    );
  }
  return {
    ...(message ? { message } : {}),
    allMessages,
    damagedFiles: snapshot.corruptFiles ?? [],
  };
}

function uniqueMessage(
  messages: Message[],
  messageId: string,
): Message | undefined {
  const matches = messages.filter((message) => message.id === messageId);
  if (matches.length === 0) return undefined;
  const serialized = new Set(matches.map((message) => JSON.stringify(message)));
  return serialized.size === 1 ? matches[0] : undefined;
}

async function folderContainsDriveItem(
  folderId: string,
  driveItemId: string,
  accessToken: string,
): Promise<boolean> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(folderId)}/children?$select=id&$top=200`;
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `Attachment cleanup verification failed: ${await readGraphError(response)}`,
      );
    }
    const page = childrenPageSchema.parse(await response.json());
    if (page.value.some((item) => item.id === driveItemId)) return true;
    url = page["@odata.nextLink"];
    if (url && !url.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error(
        "OneDrive returned an invalid attachment pagination URL.",
      );
    }
  }
  return false;
}

async function listTombstones(
  accessToken: string,
): Promise<z.infer<typeof tombstoneDocumentSchema>["tombstones"]> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/tombstones:/children?$select=id,name&$top=200`;
  const tombstones: z.infer<typeof tombstoneDocumentSchema>["tombstones"] = [];
  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(
        `Attachment cleanup scan failed: ${await readGraphError(response)}`,
      );
    }
    const page = childrenPageSchema.parse(await response.json());
    for (const item of page.value) {
      if (!/^\d{4}-\d{2}\.json$/u.test(item.name ?? "")) continue;
      const content = await fetch(
        `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!content.ok) {
        throw new Error(
          `Attachment cleanup could not read deletion records: ${await readGraphError(content)}`,
        );
      }
      const document = tombstoneDocumentSchema.parse(await content.json());
      if (`${document.month}.json` !== item.name) {
        throw new Error(
          "An attachment cleanup record belongs to another month.",
        );
      }
      tombstones.push(...document.tombstones);
    }
    url = page["@odata.nextLink"];
    if (url && !url.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error("OneDrive returned an invalid tombstone pagination URL.");
    }
  }
  return tombstones.sort((left, right) =>
    left.deletedAt.localeCompare(right.deletedAt),
  );
}

async function readState(): Promise<CleanupState> {
  const value = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return cleanupStateSchema.parse(value ?? {});
}

async function writeState(state: CleanupState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

function assertCurrentGeneration(generation: number): void {
  if (generation !== cleanupGeneration) {
    throw new Error("Attachment cleanup was reset.");
  }
}
