import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import type { Attachment, Message } from "@onedrop/core/domain/message";
import { shouldUseUploadSession } from "@onedrop/core/config/files";
import { getUtcMonth } from "@onedrop/core/features/messages/month";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "@onedrop/core/features/messages/create-file-message";
import { createTextMessage } from "@onedrop/core/features/messages/create-text-message";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";
import {
  uploadLargeFileWithAccessToken,
  uploadSmallFileWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/file-uploader";
import { readMonthSnapshot } from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import { readMonthArchive } from "@onedrop/onedrive/infrastructure/onedrive/month-archive";
import {
  appendMessageWithAccessToken,
  appendTextMessageWithAccessToken,
  removeMessageWithAccessToken,
  replaceMessageWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/month-writer";
import { writeMessageTombstoneWithAccessToken } from "@onedrop/onedrive/infrastructure/onedrive/tombstones";
import { enqueueTombstoneWrite } from "@onedrop/onedrive/infrastructure/onedrive/tombstone-write-coordinator";
import { readAccountSettingsWithAccessToken } from "@onedrop/onedrive/infrastructure/onedrive/settings";
import { nativeAuth } from "./native-auth";
import { iosImageMetadata } from "./platform-values";

const appFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  webUrl: z.string().url().optional(),
  specialFolder: z.object({ name: z.string().min(1) }).optional(),
});
const attachmentDownloadSchema = z.object({
  "@microsoft.graph.downloadUrl": z.string().url(),
});

export type IosMonthTimeline = {
  month: string;
  appFolderName: string;
  messages: Message[];
  warnings: string[];
  synchronizedAt: string;
};

export async function readCurrentIosTimeline(): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const appFolder = await readAppFolder(accessToken);
  const month = getUtcMonth();
  const snapshot = await readMonthSnapshot(month, accessToken, true);

  return {
    month,
    appFolderName: appFolder.name,
    messages:
      snapshot.state === "loaded"
        ? [...snapshot.document.messages].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          )
        : [],
    warnings:
      snapshot.state === "loaded"
        ? [
            ...(snapshot.corruptFiles ?? []).map(
              (file) => `Damaged monthly record ignored: ${file.name}`,
            ),
            ...(snapshot.messageConflicts ?? []).map(
              (conflict) =>
                `Conflicting message ignored: ${conflict.messageId}`,
            ),
          ]
        : [],
    synchronizedAt: new Date().toISOString(),
  };
}

export async function sendIosTextMessage(input: {
  id: string;
  text: string;
  createdAt: string;
  senderDeviceId: string;
}): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const month = getUtcMonth(new Date(input.createdAt));
  const message = createTextMessage(
    input.text,
    new Date(input.createdAt),
    input.id,
    input.senderDeviceId,
  );
  const result = await appendTextMessageWithAccessToken(
    month,
    message,
    accessToken,
  );
  const appFolder = await readAppFolder(accessToken);

  return {
    month,
    appFolderName: appFolder.name,
    messages:
      result.state === "loaded"
        ? [...result.messages].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          )
        : [],
    warnings: [],
    synchronizedAt: new Date().toISOString(),
  };
}

export async function registerIosFileMessage(input: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  senderDeviceId: string;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
}): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const month = getUtcMonth(new Date(input.createdAt));
  const message = createUploadingFileMessage(
    {
      name: input.name,
      size: input.size,
      mimeType: input.mimeType || "application/octet-stream",
      ...iosImageMetadata(input),
    },
    input.senderDeviceId,
    new Date(input.createdAt),
    input.id,
  );
  const result = await appendMessageWithAccessToken(
    month,
    message,
    accessToken,
  );
  return resultToTimeline(month, result);
}

export async function uploadIosFile(input: {
  id: string;
  file: Blob;
  name: string;
  mimeType: string;
  createdAt: string;
  signal: AbortSignal;
  onProgress?: (
    uploadedBytes: number,
    totalBytes: number,
    segmentEndBytes: number,
    averageUploadBytesPerSecond?: number,
  ) => void;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
}): Promise<Attachment> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const common = {
    name: input.name,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.file.size,
    messageId: input.id,
    createdAt: input.createdAt,
    ...iosImageMetadata(input),
    signal: input.signal,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  };
  if (
    shouldUseUploadSession({
      size: input.file.size,
      mimeType: input.mimeType,
    })
  ) {
    return uploadLargeFileWithAccessToken(
      {
        ...common,
        blob: input.file,
        signal: input.signal,
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      },
      accessToken,
    );
  }
  return uploadSmallFileWithAccessToken(
    {
      ...common,
      base64: await blobToBase64(input.file),
    },
    accessToken,
  );
}

export async function commitIosFileMessage(input: {
  id: string;
  attachment: Attachment;
  createdAt: string;
  senderDeviceId: string;
}): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const month = getUtcMonth(new Date(input.createdAt));
  const message = createFileMessage(
    input.attachment,
    input.senderDeviceId,
    new Date(input.createdAt),
    input.id,
  );
  const result = await replaceMessageWithAccessToken(
    month,
    message,
    accessToken,
  );
  return resultToTimeline(month, result);
}

export async function discardIosFilePlaceholder(
  id: string,
  createdAt: string,
): Promise<void> {
  const { accessToken } = await nativeAuth.getAccessToken();
  await removeMessageWithAccessToken(
    getUtcMonth(new Date(createdAt)),
    id,
    accessToken,
  );
}

export async function getIosAttachmentDownloadUrl(
  driveItemId: string,
): Promise<string> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(driveItemId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`File download failed: ${await readGraphError(response)}`);
  }
  return attachmentDownloadSchema.parse(await response.json())[
    "@microsoft.graph.downloadUrl"
  ];
}

export async function deleteIosMessage(
  month: string,
  messageId: string,
): Promise<void> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const recycle = (await readAccountSettingsWithAccessToken(accessToken))
    .recycleBin;
  await enqueueTombstoneWrite(() =>
    writeMessageTombstoneWithAccessToken(
      month,
      messageId,
      accessToken,
      recycle,
    ),
  );
}

export async function readIosHistoricalTimeline(
  month: string,
): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const appFolder = await readAppFolder(accessToken);
  const archive = await readMonthArchive(month, accessToken).catch(
    () => undefined,
  );
  const snapshot = archive
    ? undefined
    : await readMonthSnapshot(month, accessToken, true);
  const messages = archive
    ? archive.document.messages
    : snapshot?.state === "loaded"
      ? snapshot.document.messages
      : [];
  return {
    month,
    appFolderName: appFolder.name,
    messages: [...messages].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    warnings: [],
    synchronizedAt: new Date().toISOString(),
  };
}

async function resultToTimeline(
  month: string,
  result: Awaited<ReturnType<typeof appendMessageWithAccessToken>>,
): Promise<IosMonthTimeline> {
  const { accessToken } = await nativeAuth.getAccessToken();
  const appFolder = await readAppFolder(accessToken);
  return {
    month,
    appFolderName: appFolder.name,
    messages:
      result.state === "loaded"
        ? [...result.messages].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          )
        : [],
    warnings: [],
    synchronizedAt: new Date().toISOString(),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function readAppFolder(accessToken: string) {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}?$select=id,name,webUrl,specialFolder`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `OneDrive app folder check failed: ${await readGraphError(response)}`,
    );
  }
  return appFolderSchema.parse(await response.json());
}
