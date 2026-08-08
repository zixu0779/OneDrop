import { z } from "zod";

import { oneDropConfig } from "../config/onedrop";
import type { Message } from "../domain/message";
import { getCurrentAccessToken } from "../features/auth/auth-service";
import { getOrCreateDeviceId } from "../features/device/device-service";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "../features/messages/create-file-message";
import { createTextMessage } from "../features/messages/create-text-message";
import { getUtcMonth } from "../features/messages/month";
import { oneDropDatabase } from "../infrastructure/indexed-db/database";
import {
  deleteMessagesFolderId,
  putMessagesFolderId,
} from "../infrastructure/indexed-db/sync-cache";
import { verifyAppFolder } from "../infrastructure/onedrive/app-folder";
import { uploadSmallFile } from "../infrastructure/onedrive/file-uploader";
import { serializeMonthDocument } from "../infrastructure/onedrive/month-serialization";
import { appendMessage } from "../infrastructure/onedrive/month-writer";

const childrenSchema = z.object({
  value: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function rebuildTestData(): Promise<void> {
  const accessToken = await getCurrentAccessToken();
  const appRoot = await verifyAppFolder();
  await deleteTestFolders(accessToken, appRoot.id);
  await Promise.all([
    oneDropDatabase.monthCache.clear(),
    oneDropDatabase.pendingTransfers.clear(),
    oneDropDatabase.pendingTexts.clear(),
    oneDropDatabase.downloads.clear(),
    deleteMessagesFolderId(),
  ]);
  await createMessagesFolder(accessToken, appRoot.id);

  const ownDeviceId = await getOrCreateDeviceId();
  const peerDeviceId = crypto.randomUUID();
  const month = getUtcMonth();
  const start = new Date();
  start.setUTCMinutes(start.getUTCMinutes() - 20);
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

  const ownText = createTextMessage(
    "Normal text from this device",
    at(0),
    crypto.randomUUID(),
    ownDeviceId,
  );
  const peerText = createTextMessage(
    "Normal text from another device",
    at(1),
    crypto.randomUUID(),
    peerDeviceId,
  );

  const uploadAndCreate = async (
    name: string,
    mimeType: string,
    base64: string,
    senderDeviceId: string,
    createdAt: Date,
    image = false,
  ) => {
    const messageId = crypto.randomUUID();
    const size = base64ByteLength(base64);
    const attachment = await uploadSmallFile({
      name,
      mimeType,
      size,
      base64,
      messageId,
      createdAt: createdAt.toISOString(),
      ...(image ? { imageWidth: 1, imageHeight: 1 } : {}),
    });
    return createFileMessage(attachment, senderDeviceId, createdAt, messageId);
  };

  const textFile = btoa("OneDrop normal test file\n");
  const [ownFile, peerFile, ownImage, peerImage, brokenPreview] =
    await Promise.all([
      uploadAndCreate(
        "this-device.txt",
        "text/plain",
        textFile,
        ownDeviceId,
        at(2),
      ),
      uploadAndCreate(
        "other-device.txt",
        "text/plain",
        textFile,
        peerDeviceId,
        at(3),
      ),
      uploadAndCreate(
        "this-device.png",
        "image/png",
        onePixelPng,
        ownDeviceId,
        at(4),
        true,
      ),
      uploadAndCreate(
        "other-device.png",
        "image/png",
        onePixelPng,
        peerDeviceId,
        at(5),
        true,
      ),
      uploadAndCreate(
        "preview-unavailable.png",
        "image/png",
        btoa("This is intentionally not an image."),
        peerDeviceId,
        at(8),
        true,
      ),
    ]);

  const remoteMessages: Message[] = [
    ownText,
    peerText,
    ownFile,
    peerFile,
    ownImage,
    peerImage,
    createFileMessage(
      {
        driveItemId: crypto.randomUUID(),
        name: "missing-document.pdf",
        size: 2048,
        mimeType: "application/pdf",
      },
      peerDeviceId,
      at(6),
      crypto.randomUUID(),
    ),
    createFileMessage(
      {
        driveItemId: crypto.randomUUID(),
        name: "missing-image.png",
        size: 1024,
        mimeType: "image/png",
        imageWidth: 640,
        imageHeight: 480,
      },
      ownDeviceId,
      at(7),
      crypto.randomUUID(),
    ),
    brokenPreview,
    createUploadingFileMessage(
      {
        name: "unresponsive-transfer.zip",
        size: 4096,
        mimeType: "application/zip",
      },
      peerDeviceId,
      at(9),
      crypto.randomUUID(),
    ),
  ];

  for (const message of remoteMessages) await appendMessage(month, message);

  await seedLocalFailures(at(10));
  await createConflictAndDamage(accessToken, month, ownText, peerDeviceId);
}

async function createMessagesFolder(
  accessToken: string,
  appRootId: string,
): Promise<void> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(appRootId)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "messages",
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      }),
    },
  );
  if (!response.ok) throw new Error("Unable to recreate OneDrop messages.");
  const folder = z
    .object({ id: z.string().min(1) })
    .parse(await response.json());
  await putMessagesFolderId(folder.id);
}

async function seedLocalFailures(createdAt: Date): Promise<void> {
  const failedTexts = [
    "Failed text",
    "Text message that failed to send",
    "A somewhat longer text message that failed to send during testing",
    "This deliberately long text message failed to send and should wrap across three or more lines so every responsive side-control layout can be tested.",
  ];
  await oneDropDatabase.pendingTexts.bulkPut(
    failedTexts.map((text, index) => ({
      id: crypto.randomUUID(),
      createdAt: new Date(createdAt.getTime() + index * 60_000).toISOString(),
      text,
      status: "send-failed" as const,
      error: "Test failure",
    })),
  );
  await oneDropDatabase.pendingTransfers.bulkPut([
    {
      id: crypto.randomUUID(),
      createdAt: new Date(createdAt.getTime() + 4 * 60_000).toISOString(),
      name: "failed-document.pdf",
      mimeType: "application/pdf",
      size: 24,
      lastModified: Date.now(),
      blob: new Blob(["OneDrop failed file fixture"]),
      isImage: false,
      status: "upload-failed",
      error: "Test failure",
    },
    {
      id: crypto.randomUUID(),
      createdAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      name: "failed-image.png",
      mimeType: "image/png",
      size: base64ByteLength(onePixelPng),
      lastModified: Date.now(),
      blob: base64Blob(onePixelPng, "image/png"),
      isImage: true,
      imageWidth: 1,
      imageHeight: 1,
      status: "upload-failed",
      error: "Test failure",
    },
  ]);
}

async function createConflictAndDamage(
  accessToken: string,
  month: string,
  original: Extract<Message, { type: "text" }>,
  peerDeviceId: string,
): Promise<void> {
  const conflicting = createTextMessage(
    "Conflicting version from another device",
    new Date(original.createdAt),
    original.id,
    peerDeviceId,
  );
  await putRecordFile(
    accessToken,
    month,
    "0002.json",
    serializeMonthDocument({
      schemaVersion: 1,
      month,
      messages: [conflicting],
    }),
  );
  await putRecordFile(
    accessToken,
    month,
    "0003.json",
    `{"schemaVersion":1,"month":${JSON.stringify(month)},"messages":[BROKEN]}`,
  );
}

async function deleteTestFolders(
  accessToken: string,
  appRootId: string,
): Promise<void> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(appRootId)}/children?$select=id,name&$top=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error("Unable to list OneDrop test folders.");
  const children = childrenSchema.parse(await response.json()).value;
  for (const child of children) {
    if (child.name !== "messages" && child.name !== "files") continue;
    const deleted = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(child.id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Unable to delete old OneDrop ${child.name}.`);
    }
  }
}

async function putRecordFile(
  accessToken: string,
  month: string,
  name: string,
  body: string,
): Promise<void> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages/${month}/${name}:/content?@microsoft.graph.conflictBehavior=fail`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    },
  );
  if (!response.ok) throw new Error(`Unable to create ${name}.`);
}

function base64ByteLength(value: string): number {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    .byteLength;
}

function base64Blob(value: string, type: string): Blob {
  return new Blob(
    [Uint8Array.from(atob(value), (character) => character.charCodeAt(0))],
    { type },
  );
}
