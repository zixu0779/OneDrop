import Dexie, { type EntityTable } from "dexie";

import type { MonthDocument } from "../../domain/month-document";

export type MonthCacheRecord = {
  month: string;
  itemId: string;
  eTag: string;
  document: MonthDocument;
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
