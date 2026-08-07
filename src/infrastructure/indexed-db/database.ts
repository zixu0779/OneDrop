import Dexie, { type EntityTable } from "dexie";

import type { MonthDocument } from "../../domain/month-document";

export type CachedChunk = {
  index: number;
  itemId: string;
  eTag: string;
  document: MonthDocument;
};

export type MonthCacheRecord = {
  month: string;
  itemId: string;
  eTag: string;
  document: MonthDocument;
  chunks?: CachedChunk[];
  cachedAt: string;
};

type SettingRecord = {
  key: string;
  value: string;
};

class OneDropDatabase extends Dexie {
  monthCache!: EntityTable<MonthCacheRecord, "month">;
  settings!: EntityTable<SettingRecord, "key">;

  constructor() {
    super("OneDrop");
    this.version(1).stores({
      monthCache: "&month",
      settings: "&key",
    });
  }
}

export const oneDropDatabase = new OneDropDatabase();
