import Dexie, { type EntityTable } from "dexie";

import type { MonthDocument } from "@onedrop/core/domain/month-document";
import type { Attachment } from "@onedrop/core/domain/message";

export type CachedChunk = {
  index: number;
  itemId: string;
  eTag: string;
  document: MonthDocument;
  messageLines?: Record<string, number>;
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
  pausedForAccountChange?: boolean;
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
  status:
    | "uploading"
    | "committing"
    | "upload-failed"
    | "commit-failed"
    | "cancelled";
  error?: string;
  attachment?: Attachment;
  progress?: number;
  progressTarget?: number;
  averageUploadBytesPerSecond?: number;
};

export type PendingTextRecord = {
  pausedForAccountChange?: boolean;
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

export type AttachmentCacheRecord = {
  driveItemId: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  cachedAt: string;
};

export class OneDropDatabase extends Dexie {
  monthCache!: EntityTable<MonthCacheRecord, "month">;
  settings!: EntityTable<SettingRecord, "key">;
  pendingTransfers!: EntityTable<PendingTransferRecord, "id">;
  pendingTexts!: EntityTable<PendingTextRecord, "id">;
  downloads!: EntityTable<DownloadRecord, "driveItemId">;
  attachmentCache!: EntityTable<AttachmentCacheRecord, "driveItemId">;

  constructor(name = "OneDrop") {
    super(name);
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
    this.version(5).stores({
      monthCache: "&month",
      settings: "&key",
      pendingTransfers: "&id,createdAt,status",
      pendingTexts: "&id,createdAt,status",
      downloads: "&driveItemId,downloadId,lastOpenedAt",
      attachmentCache: "&driveItemId,cachedAt",
    });
  }
}

export let oneDropDatabase = new OneDropDatabase();

let nativeConfigured = false;

// Native startup only: changing accounts requires a new document, not a live swap.
export function configureNativeDatabase(scope: string): void {
  if (nativeConfigured)
    throw new Error("Native database changes require a new document.");
  nativeConfigured = true;
  oneDropDatabase.close();
  oneDropDatabase = new OneDropDatabase(`OneDrop.native.${scope}`);
}

// Background switches call this only after all old-account work has drained.
export function configureExtensionDatabase(scope: string): void {
  oneDropDatabase.close();
  oneDropDatabase = new OneDropDatabase(`OneDrop.edge.${scope}`);
}
