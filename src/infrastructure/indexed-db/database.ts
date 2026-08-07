import Dexie, { type EntityTable } from "dexie";

import type { MonthDocument } from "../../domain/month-document";
import type { Attachment } from "../../domain/message";

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

export type PendingTransferRecord = {
  id: string;
  createdAt: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  blob: Blob;
  isImage: boolean;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
  status: "uploading" | "committing" | "upload-failed" | "commit-failed";
  error?: string;
  attachment?: Attachment;
};

export type PendingTextRecord = {
  id: string;
  createdAt: string;
  text: string;
  status: "sending" | "send-failed";
  error?: string;
};

export type DownloadRecord = {
  driveItemId: string;
  downloadId: number;
  cloudName: string;
  localFilename?: string;
  createdAt: string;
  lastOpenedAt?: string;
};

class OneDropDatabase extends Dexie {
  monthCache!: EntityTable<MonthCacheRecord, "month">;
  settings!: EntityTable<SettingRecord, "key">;
  pendingTransfers!: EntityTable<PendingTransferRecord, "id">;
  pendingTexts!: EntityTable<PendingTextRecord, "id">;
  downloads!: EntityTable<DownloadRecord, "driveItemId">;

  constructor() {
    super("OneDrop");
    this.version(1).stores({
      monthCache: "&month",
      settings: "&key",
    });
    this.version(2).stores({
      monthCache: "&month",
      settings: "&key",
      pendingTransfers: "&id,createdAt,status",
    });
    this.version(3).stores({
      monthCache: "&month",
      settings: "&key",
      pendingTransfers: "&id,createdAt,status",
      downloads: "&driveItemId,downloadId,lastOpenedAt",
    });
    this.version(4).stores({
      monthCache: "&month",
      settings: "&key",
      pendingTransfers: "&id,createdAt,status",
      pendingTexts: "&id,createdAt,status",
      downloads: "&driveItemId,downloadId,lastOpenedAt",
    });
  }
}

export const oneDropDatabase = new OneDropDatabase();
