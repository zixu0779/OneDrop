import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type { MonthReadResult } from "../../contracts/runtime-messages";
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

export type MonthSnapshot =
  | { state: "missing"; month: string }
  | {
      state: "loaded";
      month: string;
      itemId: string;
      eTag: string;
      document: MonthDocument;
      chunks: CachedChunk[];
    };

export async function readMonthDocument(
  month: string,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  const snapshot = await readMonthSnapshot(month, accessToken);

  return snapshot.state === "missing"
    ? snapshot
    : {
        state: "loaded",
        month,
        eTag: snapshot.eTag,
        messages: snapshot.document.messages,
      };
}

export async function readMonthSnapshot(
  month: string,
  accessToken: string,
): Promise<MonthSnapshot> {
  assertMonth(month);
  const cached = await getCachedMonthSnapshot(month);
  const chunks = await readChunks(month, accessToken, cached?.chunks ?? []);

  if (chunks.length === 0) {
    await deleteMonthCache(month);
    return { state: "missing", month };
  }

  const messages = mergeMessages(
    chunks.flatMap((chunk) => chunk.document.messages),
  );
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
    chunks: chunks.data,
  };
}

const cachedChunkSchema = z.object({
  index: z.number().int().positive(),
  itemId: z.string().min(1),
  eTag: z.string().min(1),
  document: monthDocumentSchema,
});

async function readChunks(
  month: string,
  accessToken: string,
  cachedChunks: CachedChunk[],
): Promise<CachedChunk[]> {
  let url: string | undefined =
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages/${month}:/children?$select=id,name,eTag&$top=200`;
  const items: z.infer<typeof driveItemSchema>[] = [];

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404) return [];
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

  for (const item of items) {
    const match = item.name?.match(chunkNamePattern);
    if (!match) continue;
    const index = Number(match[1]);
    const cached = cachedById.get(item.id);
    const document =
      cached?.eTag === item.eTag
        ? cached.document
        : await downloadDocument(item.id, month, accessToken);
    chunks.push({ index, itemId: item.id, eTag: item.eTag, document });
  }

  return chunks.sort((left, right) => left.index - right.index);
}

async function downloadDocument(
  itemId: string,
  month: string,
  accessToken: string,
): Promise<MonthDocument> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Monthly message download failed: ${await readGraphError(response)}`,
    );
  }
  const document = monthDocumentSchema.parse(await response.json());
  if (document.month !== month) {
    throw new Error(
      `Monthly message document mismatch: expected ${month}, received ${document.month}.`,
    );
  }
  return document;
}

function mergeMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    const existing = byId.get(message.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(message)) {
      throw new Error(
        `OneDrive contains conflicting message ID ${message.id}.`,
      );
    }
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function assertMonth(month: string): void {
  if (!monthPattern.test(month)) {
    throw new Error("OneDrop received an invalid UTC month partition.");
  }
}
