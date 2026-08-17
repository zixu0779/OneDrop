import type { MonthDocument } from "@onedrop/core/domain/month-document";
import {
  oneDropDatabase,
  type CachedChunk,
  type MonthCacheRecord,
} from "./database";

const MESSAGES_FOLDER_KEY = "onedrive.messagesFolderId";

export function getMonthCache(
  month: string,
): Promise<MonthCacheRecord | undefined> {
  return oneDropDatabase.monthCache.get(month);
}

export async function putMonthCache(input: {
  month: string;
  itemId: string;
  eTag: string;
  document: MonthDocument;
  chunks?: CachedChunk[];
}): Promise<void> {
  await oneDropDatabase.monthCache.put({
    ...input,
    cachedAt: new Date().toISOString(),
  });
}

export function deleteMonthCache(month: string): Promise<void> {
  return oneDropDatabase.monthCache.delete(month);
}

export async function getMessagesFolderId(): Promise<string | undefined> {
  return (await oneDropDatabase.settings.get(MESSAGES_FOLDER_KEY))?.value;
}

export async function putMessagesFolderId(id: string): Promise<void> {
  await oneDropDatabase.settings.put({ key: MESSAGES_FOLDER_KEY, value: id });
}

export function deleteMessagesFolderId(): Promise<void> {
  return oneDropDatabase.settings.delete(MESSAGES_FOLDER_KEY);
}
