import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type {
  CorruptMonthFile,
  MessageConflict,
  MonthReadResult,
} from "../../contracts/runtime-messages";
import {
  monthDocumentSchema,
  type MonthDocument,
} from "../../domain/month-document";
import type { Message } from "../../domain/message";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import type { CachedChunk } from "../indexed-db/database";
import {
  deleteMonthCache,
  getMonthCache,
  putMonthCache,
} from "../indexed-db/sync-cache";
import { getMessageLines } from "./month-serialization";
import { readTombstoneIds } from "./tombstones";

const monthPattern = /^\d{4}-\d{2}$/u;
const chunkNamePattern = /^(\d{4})\.json$/u;

const driveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  eTag: z.string().min(1),
});
const childrenPageSchema = z.object({
  value: z.array(driveItemSchema),
  "@odata.nextLink": z.string().url().optional(),
});

class DamagedMonthDocumentError extends Error {}

export type MonthSnapshot =
  | { state: "missing"; month: string; corruptFiles?: CorruptMonthFile[] }
  | {
      state: "loaded";
      month: string;
      itemId: string;
      eTag: string;
      document: MonthDocument;
      chunks: CachedChunk[];
      corruptFiles?: CorruptMonthFile[];
      messageConflicts?: MessageConflict[];
    };

export async function readMonthDocument(
  month: string,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  const snapshot = await readMonthSnapshot(month, accessToken, true);

  return snapshot.state === "missing"
    ? snapshot
    : {
        state: "loaded",
        month,
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

export async function readMonthSnapshot(
  month: string,
  accessToken: string,
  allowCorruptFiles = false,
): Promise<MonthSnapshot> {
  assertMonth(month);
  const cached = await getCachedMonthSnapshot(month);
  const { chunks, corruptFiles } = await readChunks(
    month,
    accessToken,
    cached?.chunks ?? [],
  );

  if (!allowCorruptFiles && corruptFiles.length > 0) {
    throw new Error(
      `OneDrive contains a damaged monthly record file: ${corruptFiles[0]!.name}.`,
    );
  }

  if (chunks.length === 0) {
    await deleteMonthCache(month);
    return {
      state: "missing",
      month,
      ...(corruptFiles.length > 0 ? { corruptFiles } : {}),
    };
  }

  const {
    messages: unfilteredMessages,
    messageConflicts: unfilteredConflicts,
  } = mergeMessages(chunks);
  const deletedMessageIds = await readTombstoneIds(month, accessToken);
  const messages = unfilteredMessages.filter(
    (message) => !deletedMessageIds.has(message.id),
  );
  const messageConflicts = unfilteredConflicts.filter(
    (conflict) => !deletedMessageIds.has(conflict.messageId),
  );
  if (!allowCorruptFiles && messageConflicts.length > 0) {
    throw new Error(
      `OneDrive contains conflicting versions of message ${messageConflicts[0]!.messageId}.`,
    );
  }
  const active = chunks.at(-1)!;
  const document = monthDocumentSchema.parse({
    schemaVersion: 1,
    month,
    messages,
  });
  const snapshot: Extract<MonthSnapshot, { state: "loaded" }> = {
    state: "loaded",
    month,
    itemId: active.itemId,
    eTag: active.eTag,
    document,
    chunks,
    corruptFiles,
    messageConflicts,
  };

  await putMonthCache(snapshot);
  return snapshot;
}

export async function getCachedMonthSnapshot(
  month: string,
): Promise<Extract<MonthSnapshot, { state: "loaded" }> | undefined> {
  const cached = await getMonthCache(month);
  if (!cached) return undefined;

  const document = monthDocumentSchema.safeParse(cached.document);
  const chunks = z.array(cachedChunkSchema).safeParse(cached.chunks ?? []);

  if (
    !document.success ||
    document.data.month !== month ||
    !chunks.success ||
    chunks.data.length === 0
  ) {
    await deleteMonthCache(month);
    return undefined;
  }

  return {
    state: "loaded",
    month,
    itemId: cached.itemId,
    eTag: cached.eTag,
    document: document.data,
    chunks: chunks.data.map(({ messageLines, ...chunk }) => ({
      ...chunk,
      ...(messageLines ? { messageLines } : {}),
    })),
  };
}

const cachedChunkSchema = z.object({
  index: z.number().int().positive(),
  itemId: z.string().min(1),
  eTag: z.string().min(1),
  document: monthDocumentSchema,
  messageLines: z.record(z.string(), z.number().int().positive()).optional(),
});

async function readChunks(
  month: string,
  accessToken: string,
  cachedChunks: CachedChunk[],
): Promise<{ chunks: CachedChunk[]; corruptFiles: CorruptMonthFile[] }> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages/${month}:/children?$select=id,name,eTag&$top=200`;
  const items: z.infer<typeof driveItemSchema>[] = [];

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return { chunks: [], corruptFiles: [] };
    if (!response.ok) {
      throw new Error(
        `Monthly chunk listing failed: ${await readGraphError(response)}`,
      );
    }
    const page = childrenPageSchema.parse(await response.json());
    items.push(...page.value);
    url = page["@odata.nextLink"];
    if (url && !url.startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error("OneDrive returned an invalid chunk pagination URL.");
    }
  }

  const cachedById = new Map(
    cachedChunks.map((chunk) => [chunk.itemId, chunk]),
  );
  const chunks: CachedChunk[] = [];
  const corruptFiles: CorruptMonthFile[] = [];

  for (const item of items) {
    const match = item.name?.match(chunkNamePattern);
    if (!match) continue;
    const index = Number(match[1]);
    const cached = cachedById.get(item.id);
    try {
      const downloaded =
        cached?.eTag === item.eTag && cached.messageLines
          ? { document: cached.document, messageLines: cached.messageLines }
          : await downloadDocument(item.id, month, accessToken);
      chunks.push({
        index,
        itemId: item.id,
        eTag: item.eTag,
        document: downloaded.document,
        messageLines: downloaded.messageLines,
      });
    } catch (error) {
      if (!(error instanceof DamagedMonthDocumentError)) throw error;
      corruptFiles.push({ itemId: item.id, name: item.name ?? "Unknown file" });
    }
  }

  return {
    chunks: chunks.sort((left, right) => left.index - right.index),
    corruptFiles,
  };
}

async function downloadDocument(
  itemId: string,
  month: string,
  accessToken: string,
): Promise<{ document: MonthDocument; messageLines: Record<string, number> }> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Monthly message download failed: ${await readGraphError(response)}`,
    );
  }
  let document: MonthDocument;
  let serialized: string;
  try {
    serialized = await response.text();
    document = monthDocumentSchema.parse(JSON.parse(serialized));
  } catch (error) {
    throw new DamagedMonthDocumentError("Invalid monthly message document.", {
      cause: error,
    });
  }
  if (document.month !== month) {
    throw new DamagedMonthDocumentError(
      `Monthly message document mismatch: expected ${month}, received ${document.month}.`,
    );
  }
  return { document, messageLines: getMessageLines(serialized, document) };
}

function mergeMessages(chunks: CachedChunk[]): {
  messages: Message[];
  messageConflicts: MessageConflict[];
} {
  const byId = new Map<
    string,
    { message: Message; itemId: string; name: string; line: number }
  >();
  const conflictsById = new Map<string, MessageConflict>();
  for (const chunk of chunks) {
    const name = `${chunk.index.toString().padStart(4, "0")}.json`;
    chunk.document.messages.forEach((message, index) => {
      const source = {
        message,
        itemId: chunk.itemId,
        name,
        line: chunk.messageLines?.[message.id] ?? index + 1,
      };
      const existing = byId.get(message.id);
      if (!existing) {
        byId.set(message.id, source);
        return;
      }
      if (JSON.stringify(existing.message) === JSON.stringify(message)) return;
      const conflict = conflictsById.get(message.id) ?? {
        messageId: message.id,
        versions: [
          {
            itemId: existing.itemId,
            name: existing.name,
            line: existing.line,
          },
        ],
      };
      if (
        !conflict.versions.some((version) => version.itemId === chunk.itemId)
      ) {
        conflict.versions.push({
          itemId: chunk.itemId,
          name,
          line: chunk.messageLines?.[message.id] ?? index + 1,
        });
      }
      conflictsById.set(message.id, conflict);
    });
  }
  return {
    messages: [...byId.values()]
      .map(({ message }) => message)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    messageConflicts: [...conflictsById.values()],
  };
}

function assertMonth(month: string): void {
  if (!monthPattern.test(month)) {
    throw new Error("OneDrop received an invalid UTC month partition.");
  }
}
