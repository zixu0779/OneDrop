import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import type { MonthReadResult } from "@onedrop/core/contracts/runtime-messages";
import { monthDocumentSchema } from "@onedrop/core/domain/month-document";
import type { Message, TextMessage } from "@onedrop/core/domain/message";
import { getCurrentAccessToken } from "@onedrop/app-runtime/features/auth/auth-service";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";
import {
  deleteMessagesFolderId,
  deleteMonthCache,
  getMessagesFolderId,
  putMessagesFolderId,
  putMonthCache,
} from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readMonthSnapshot,
  type MonthSnapshot,
} from "./month-reader";
import {
  getMessageLines,
  serializedDocumentBytes,
  serializeMonthDocument,
} from "./month-serialization";
import { verifyAppFolderWithAccessToken } from "./app-folder";

const MAX_ATTEMPTS = 5;
export const CHUNK_SOFT_LIMIT_BYTES = 256 * 1024;
export const CHUNK_HARD_LIMIT_BYTES = 320 * 1024;

const writtenItemSchema = z.object({
  id: z.string().min(1),
  eTag: z.string().min(1),
});
const folderItemSchema = z.object({
  id: z.string().min(1),
  folder: z.object({ childCount: z.number().int().nonnegative().optional() }),
});

export async function appendTextMessage(
  month: string,
  message: TextMessage,
): Promise<MonthReadResult> {
  return appendMessage(month, message);
}

export function appendTextMessageWithAccessToken(
  month: string,
  message: TextMessage,
  accessToken: string,
): Promise<MonthReadResult> {
  return appendMessageWithAccessToken(month, message, accessToken);
}

export async function appendMessage(
  month: string,
  message: Message,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  return appendMessageWithAccessToken(month, message, accessToken);
}

export async function appendMessageWithAccessToken(
  month: string,
  message: Message,
  accessToken: string,
): Promise<MonthReadResult> {
  await ensureMessagesFolder(accessToken);
  let snapshot: MonthSnapshot | undefined = await getCachedMonthSnapshot(month);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    snapshot ??= await readWritableMonthSnapshot(
      month,
      accessToken,
      message.id,
    );
    const existingMessages =
      snapshot.state === "loaded" ? snapshot.document.messages : [];

    if (existingMessages.some((item) => item.id === message.id)) {
      if (snapshot.state === "missing") return snapshot;
      return {
        state: "loaded",
        month,
        eTag: snapshot.eTag,
        messages: snapshot.document.messages,
      };
    }

    const chunks = snapshot.state === "loaded" ? snapshot.chunks : [];
    const active = chunks.at(-1);
    const candidate = mergeMessage(
      month,
      active?.document.messages ?? [],
      message,
    ).document;
    const shouldCreateChunk =
      !active || serializedBytes(candidate) > CHUNK_SOFT_LIMIT_BYTES;
    const document = shouldCreateChunk
      ? mergeMessage(month, [], message).document
      : candidate;

    if (serializedBytes(document) > CHUNK_HARD_LIMIT_BYTES) {
      throw new Error(
        "This message is too large for a OneDrop metadata chunk.",
      );
    }

    const chunkIndex = shouldCreateChunk
      ? nextAvailableChunkIndex(snapshot)
      : active.index;
    if (chunkIndex > 9_999) {
      throw new Error("The current month reached OneDrop's chunk count limit.");
    }
    const body = serializeMonthDocument(document);

    let response: Response;

    try {
      if (shouldCreateChunk) {
        await ensureMonthFolder(accessToken, month);
        response = await createChunk(accessToken, month, chunkIndex, body);
      } else {
        response = await updateMonth(
          accessToken,
          active.itemId,
          active.eTag,
          body,
        );
      }
    } catch (error) {
      // The request may have reached OneDrive even when the client never
      // received its response. Invalidate the snapshot, but never replay an
      // ambiguous write automatically.
      await deleteMonthCache(month);
      throw error;
    }

    if (response.status === 409 || response.status === 412) {
      await deleteMonthCache(month);
      snapshot = undefined;
      continue;
    }

    if (response.status === 404) {
      await Promise.all([deleteMonthCache(month), deleteMessagesFolderId()]);
      await ensureMessagesFolder(accessToken);
      snapshot = undefined;
      continue;
    }

    if (!response.ok) {
      const error = await readGraphError(response);
      throw new Error(`Monthly message write failed: ${error}`);
    }

    const item = writtenItemSchema.parse(await response.json());
    const writtenChunk = {
      index: chunkIndex,
      itemId: item.id,
      eTag: item.eTag,
      document,
      messageLines: getMessageLines(body, document),
    };
    const nextChunks = shouldCreateChunk
      ? [...chunks, writtenChunk]
      : [...chunks.slice(0, -1), writtenChunk];
    const aggregateDocument = monthDocumentSchema.parse({
      schemaVersion: 1,
      month,
      messages: [...existingMessages, message],
    });
    await putMonthCache({
      month,
      itemId: item.id,
      eTag: item.eTag,
      document: aggregateDocument,
      chunks: nextChunks,
    });
    return {
      state: "loaded",
      month,
      eTag: item.eTag,
      messages: aggregateDocument.messages,
    };
  }

  throw new Error(
    "The monthly message document changed repeatedly. Try sending again.",
  );
}

export async function replaceMessage(
  month: string,
  message: Message,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  return replaceMessageWithAccessToken(month, message, accessToken);
}

export async function replaceMessageWithAccessToken(
  month: string,
  message: Message,
  accessToken: string,
): Promise<MonthReadResult> {
  await ensureMessagesFolder(accessToken);
  let snapshot: MonthSnapshot | undefined = await getCachedMonthSnapshot(month);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    snapshot ??= await readWritableMonthSnapshot(
      month,
      accessToken,
      message.id,
    );
    if (snapshot.state === "missing") {
      throw new Error("The registered file message no longer exists.");
    }

    const chunkPosition = snapshot.chunks.findIndex((chunk) =>
      chunk.document.messages.some((item) => item.id === message.id),
    );
    if (chunkPosition < 0) {
      throw new Error("The registered file message no longer exists.");
    }

    const existing = snapshot.document.messages.find(
      (item) => item.id === message.id,
    );
    if (existing?.type === "file") {
      return {
        state: "loaded",
        month,
        eTag: snapshot.eTag,
        messages: snapshot.document.messages,
      };
    }

    const target = snapshot.chunks[chunkPosition]!;
    const document = monthDocumentSchema.parse({
      ...target.document,
      messages: target.document.messages.map((item) =>
        item.id === message.id ? message : item,
      ),
    });
    if (serializedBytes(document) > CHUNK_HARD_LIMIT_BYTES) {
      throw new Error(
        "The finalized message is too large for its metadata chunk.",
      );
    }
    const body = serializeMonthDocument(document);

    let response: Response;
    try {
      response = await updateMonth(
        accessToken,
        target.itemId,
        target.eTag,
        body,
      );
    } catch (error) {
      await deleteMonthCache(month);
      throw error;
    }

    if (response.status === 409 || response.status === 412) {
      await deleteMonthCache(month);
      snapshot = undefined;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Monthly message update failed: ${await readGraphError(response)}`,
      );
    }

    const item = writtenItemSchema.parse(await response.json());
    const writtenChunk = {
      ...target,
      itemId: item.id,
      eTag: item.eTag,
      document,
      messageLines: getMessageLines(body, document),
    };
    const nextChunks = snapshot.chunks.map((chunk, index) =>
      index === chunkPosition ? writtenChunk : chunk,
    );
    const aggregateDocument = monthDocumentSchema.parse({
      ...snapshot.document,
      messages: snapshot.document.messages.map((item) =>
        item.id === message.id ? message : item,
      ),
    });
    await putMonthCache({
      month,
      itemId: item.id,
      eTag: item.eTag,
      document: aggregateDocument,
      chunks: nextChunks,
    });
    return {
      state: "loaded",
      month,
      eTag: item.eTag,
      messages: aggregateDocument.messages,
    };
  }

  throw new Error(
    "The monthly message document changed repeatedly. Try sending again.",
  );
}

export async function removeMessage(
  month: string,
  messageId: string,
): Promise<void> {
  const accessToken = await getCurrentAccessToken();
  return removeMessageWithAccessToken(month, messageId, accessToken);
}

export async function removeMessageWithAccessToken(
  month: string,
  messageId: string,
  accessToken: string,
): Promise<void> {
  let snapshot: MonthSnapshot | undefined = await getCachedMonthSnapshot(month);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    snapshot ??= await readWritableMonthSnapshot(month, accessToken, messageId);
    if (snapshot.state === "missing") return;
    const chunkPosition = snapshot.chunks.findIndex((chunk) =>
      chunk.document.messages.some(
        (message) =>
          message.id === messageId && message.type === "file-uploading",
      ),
    );
    if (chunkPosition < 0) return;
    const target = snapshot.chunks[chunkPosition]!;
    const document = monthDocumentSchema.parse({
      ...target.document,
      messages: target.document.messages.filter(
        (message) =>
          message.id !== messageId || message.type !== "file-uploading",
      ),
    });
    const body = serializeMonthDocument(document);

    let response: Response;
    try {
      response = await updateMonth(
        accessToken,
        target.itemId,
        target.eTag,
        body,
      );
    } catch (error) {
      await deleteMonthCache(month);
      throw error;
    }
    if (response.status === 409 || response.status === 412) {
      await deleteMonthCache(month);
      snapshot = undefined;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Monthly placeholder removal failed: ${await readGraphError(response)}`,
      );
    }
    const item = writtenItemSchema.parse(await response.json());
    const writtenChunk = {
      ...target,
      itemId: item.id,
      eTag: item.eTag,
      document,
      messageLines: getMessageLines(body, document),
    };
    const nextChunks = snapshot.chunks.map((chunk, index) =>
      index === chunkPosition ? writtenChunk : chunk,
    );
    const aggregateDocument = monthDocumentSchema.parse({
      ...snapshot.document,
      messages: snapshot.document.messages.filter(
        (message) =>
          message.id !== messageId || message.type !== "file-uploading",
      ),
    });
    await putMonthCache({
      month,
      itemId: item.id,
      eTag: item.eTag,
      document: aggregateDocument,
      chunks: nextChunks,
    });
    return;
  }
  throw new Error("The placeholder changed repeatedly. Try again later.");
}

export async function resolveMessageConflict(
  month: string,
  messageId: string,
  keepItemId: string,
): Promise<MonthReadResult> {
  return resolveMessageConflictWithAccessToken(
    month,
    messageId,
    keepItemId,
    await getCurrentAccessToken(),
  );
}

export async function resolveMessageConflictWithAccessToken(
  month: string,
  messageId: string,
  keepItemId: string,
  accessToken: string,
): Promise<MonthReadResult> {
  const snapshot = await readMonthSnapshot(month, accessToken, true);
  if (snapshot.state === "missing") {
    throw new Error("The conflicting message no longer exists.");
  }
  const conflict = snapshot.messageConflicts?.find(
    (item) => item.messageId === messageId,
  );
  if (!conflict) return monthSnapshotResult(snapshot);
  if (!conflict.versions.some((version) => version.itemId === keepItemId)) {
    throw new Error("The selected message version no longer exists.");
  }

  for (const version of conflict.versions) {
    if (version.itemId === keepItemId) continue;
    const target = snapshot.chunks.find(
      (chunk) => chunk.itemId === version.itemId,
    );
    if (!target) {
      throw new Error("A conflicting record file changed. Check again.");
    }
    const document = monthDocumentSchema.parse({
      ...target.document,
      messages: target.document.messages.filter(
        (message) => message.id !== messageId,
      ),
    });
    const body = serializeMonthDocument(document);
    const response = await updateMonth(
      accessToken,
      target.itemId,
      target.eTag,
      body,
    );
    if (response.status === 409 || response.status === 412) {
      await deleteMonthCache(month);
      throw new Error("A conflicting record file changed. Check again.");
    }
    if (!response.ok) {
      throw new Error(
        `Message conflict resolution failed: ${await readGraphError(response)}`,
      );
    }
  }

  await deleteMonthCache(month);
  const resolved = await readMonthSnapshot(month, accessToken, true);
  return monthSnapshotResult(resolved);
}

function monthSnapshotResult(snapshot: MonthSnapshot): MonthReadResult {
  if (snapshot.state === "missing") return snapshot;
  return {
    state: "loaded",
    month: snapshot.month,
    eTag: snapshot.eTag,
    messages: snapshot.document.messages,
    ...((snapshot.corruptFiles?.length ?? 0) > 0
      ? { corruptFiles: snapshot.corruptFiles }
      : {}),
    ...((snapshot.messageConflicts?.length ?? 0) > 0
      ? { messageConflicts: snapshot.messageConflicts }
      : {}),
  };
}

export function mergeTextMessage(
  month: string,
  existingMessages: Message[],
  message: TextMessage,
): ReturnType<typeof mergeMessage> {
  return mergeMessage(month, existingMessages, message);
}

export function mergeMessage(
  month: string,
  existingMessages: Message[],
  message: Message,
): {
  added: boolean;
  document: z.infer<typeof monthDocumentSchema>;
} {
  const added = !existingMessages.some((item) => item.id === message.id);
  return {
    added,
    document: monthDocumentSchema.parse({
      schemaVersion: 1,
      month,
      messages: added ? [...existingMessages, message] : existingMessages,
    }),
  };
}

async function ensureMessagesFolder(accessToken: string): Promise<void> {
  if (await getMessagesFolderId()) return;

  const existingResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/messages`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (existingResponse.ok) {
    const folder = folderItemSchema.parse(await existingResponse.json());
    await putMessagesFolderId(folder.id);
    return;
  }

  if (existingResponse.status !== 404) {
    const error = await readGraphError(existingResponse);
    throw new Error(`Messages folder lookup failed: ${error}`);
  }

  const appRoot = await verifyAppFolderWithAccessToken(accessToken);
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(appRoot.id)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "messages",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );

  if (response.ok) {
    const folder = folderItemSchema.parse(await response.json());
    await putMessagesFolderId(folder.id);
    return;
  }

  if (response.status === 409) {
    const racedResponse = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/messages`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (racedResponse.ok) {
      const folder = folderItemSchema.parse(await racedResponse.json());
      await putMessagesFolderId(folder.id);
      return;
    }
  }

  const error = await readGraphError(response);
  throw new Error(`Messages folder creation failed: ${error}`);
}

async function ensureMonthFolder(
  accessToken: string,
  month: string,
  canRepairMessagesFolder = true,
): Promise<void> {
  const existing = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/messages/${month}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `Month folder lookup failed: ${await readGraphError(existing)}`,
    );
  }

  const messagesFolderId = await getMessagesFolderId();
  if (!messagesFolderId) {
    throw new Error("OneDrop could not resolve the messages folder.");
  }
  const created = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(messagesFolderId)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: month,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  if (created.ok || created.status === 409) return;
  if (created.status === 404 && canRepairMessagesFolder) {
    await deleteMessagesFolderId();
    await ensureMessagesFolder(accessToken);
    return ensureMonthFolder(accessToken, month, false);
  }
  throw new Error(
    `Month folder creation failed: ${await readGraphError(created)}`,
  );
}

function createChunk(
  accessToken: string,
  month: string,
  index: number,
  body: string,
): Promise<Response> {
  const conflictBehavior = encodeURIComponent(
    "@microsoft.graph.conflictBehavior",
  );
  const name = `${index.toString().padStart(4, "0")}.json`;
  return fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/messages/${month}/${name}:/content?${conflictBehavior}=fail`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    },
  );
}

async function readWritableMonthSnapshot(
  month: string,
  accessToken: string,
  targetMessageId: string,
): Promise<MonthSnapshot> {
  const snapshot = await readMonthSnapshot(month, accessToken, true);
  const conflict =
    snapshot.state === "loaded"
      ? snapshot.messageConflicts?.find(
          (item) => item.messageId === targetMessageId,
        )
      : undefined;
  if (conflict) {
    throw new Error(
      `OneDrive contains conflicting versions of message ${conflict.messageId}.`,
    );
  }
  return snapshot;
}

function nextAvailableChunkIndex(snapshot: MonthSnapshot): number {
  const healthyIndexes =
    snapshot.state === "loaded"
      ? snapshot.chunks.map((chunk) => chunk.index)
      : [];
  const damagedIndexes = (snapshot.corruptFiles ?? [])
    .map((file) => file.name.match(/^(\d{4})\.json$/u)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return Math.max(0, ...healthyIndexes, ...damagedIndexes) + 1;
}

function serializedBytes(
  document: z.infer<typeof monthDocumentSchema>,
): number {
  return serializedDocumentBytes(document);
}

function updateMonth(
  accessToken: string,
  itemId: string,
  eTag: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        "If-Match": eTag,
      },
      body,
    },
  );
}
