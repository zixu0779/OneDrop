import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import { MAX_DIRECT_FILE_BYTES } from "../../config/files";
import type { Attachment } from "../../domain/message";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import {
  getAverageUploadBytesPerSecond,
  recordUploadThroughput,
} from "../indexed-db/upload-throughput";
import { verifyAppFolder } from "./app-folder";

const folderSchema = z.object({
  id: z.string().min(1),
  folder: z.object({}).passthrough(),
});
const uploadedFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
});
const attachmentStateSchema = z.object({
  id: z.string().min(1),
  deleted: z.object({ state: z.string().optional() }).optional(),
});
const attachmentDownloadSchema = z.object({
  "@microsoft.graph.downloadUrl": z.string().url(),
});
const attachmentWebSchema = z.object({ webUrl: z.string().url() });
const uploadSessionSchema = z.object({ uploadUrl: z.string().url() });

const FILE_OPERATION_TIMEOUT_MS = 12_000;

export async function uploadSmallFile(input: {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
  messageId: string;
  createdAt: string;
  reuseExisting?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
}): Promise<Attachment> {
  if (input.size > MAX_DIRECT_FILE_BYTES) {
    throw new Error("Large-file upload sessions are not implemented yet.");
  }

  const bytes = decodeBase64(input.base64);
  if (bytes.byteLength !== input.size) {
    throw new Error("The selected file changed before upload.");
  }

  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), FILE_OPERATION_TIMEOUT_MS);
  try {
    const accessToken = await getCurrentAccessToken();
    const parentId = await prepareUploadFolder(
      accessToken,
      input.createdAt,
      input.messageId,
      controller.signal,
    );

    if (input.reuseExisting) {
      const existing = await findExistingUpload(
        accessToken,
        parentId,
        input.name,
        input.size,
        controller.signal,
      );
      if (existing) {
        return {
          driveItemId: existing.id,
          name: existing.name,
          size: existing.size,
          mimeType: input.mimeType || "application/octet-stream",
          ...(input.imageWidth ? { imageWidth: input.imageWidth } : {}),
          ...(input.imageHeight ? { imageHeight: input.imageHeight } : {}),
          ...(input.thumbHash ? { thumbHash: input.thumbHash } : {}),
        };
      }
    }

    // Folder discovery can require several Graph round trips. Give the actual
    // content transfer its own timeout budget instead of sharing what remains.
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), FILE_OPERATION_TIMEOUT_MS);

    const response = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(input.name)}:/content`,
      {
        method: "PUT",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": input.mimeType || "application/octet-stream",
        },
        body: toArrayBuffer(bytes),
      },
    );
    if (!response.ok) {
      throw new Error(`File upload failed: ${await readGraphError(response)}`);
    }
    const item = uploadedFileSchema.parse(await response.json());
    return {
      driveItemId: item.id,
      name: item.name,
      size: item.size,
      mimeType: input.mimeType || "application/octet-stream",
      ...(input.imageWidth ? { imageWidth: input.imageWidth } : {}),
      ...(input.imageHeight ? { imageHeight: input.imageHeight } : {}),
      ...(input.thumbHash ? { thumbHash: input.thumbHash } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        "File upload timed out. Check your connection and Resend.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadLargeFile(input: {
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  messageId: string;
  createdAt: string;
  reuseExisting?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  thumbHash?: string;
  signal: AbortSignal;
  onProgress?: (
    uploadedBytes: number,
    totalBytes: number,
    segmentEndBytes: number,
    averageUploadBytesPerSecond?: number,
  ) => void;
}): Promise<Attachment> {
  if (input.size <= MAX_DIRECT_FILE_BYTES) {
    throw new Error("Upload sessions are only used for large files.");
  }
  if (input.blob.size !== input.size) {
    throw new Error("The selected file changed before upload.");
  }

  const accessToken = await getCurrentAccessToken();
  const parentId = await prepareUploadFolder(
    accessToken,
    input.createdAt,
    input.messageId,
    input.signal,
  );
  if (input.reuseExisting) {
    const existing = await findExistingUpload(
      accessToken,
      parentId,
      input.name,
      input.size,
      input.signal,
    );
    if (existing) return toAttachment(existing, input);
  }

  const sessionResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(input.name)}:/createUploadSession`,
    {
      method: "POST",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item: { "@microsoft.graph.conflictBehavior": "replace" },
      }),
    },
  );
  if (!sessionResponse.ok) {
    throw new Error(
      `Upload session creation failed: ${await readGraphError(sessionResponse)}`,
    );
  }
  const { uploadUrl } = uploadSessionSchema.parse(await sessionResponse.json());
  const chunkSize = 5 * 1024 * 1024;
  let uploadedBytes = 0;
  let averageUploadBytesPerSecond: number | undefined;
  try {
    averageUploadBytesPerSecond = await getAverageUploadBytesPerSecond();
  } catch {
    // Local telemetry must never block an upload.
  }

  while (uploadedBytes < input.size) {
    const end = Math.min(uploadedBytes + chunkSize, input.size);
    input.onProgress?.(
      uploadedBytes,
      input.size,
      end,
      averageUploadBytesPerSecond,
    );
    const chunk = input.blob.slice(uploadedBytes, end);
    const { response, successfulAttemptDurationMs } =
      await uploadChunkWithRetry(
        uploadUrl,
        chunk,
        uploadedBytes,
        end,
        input.size,
        input.signal,
      );
    try {
      averageUploadBytesPerSecond =
        (await recordUploadThroughput(
          end - uploadedBytes,
          successfulAttemptDurationMs,
        )) ?? averageUploadBytesPerSecond;
    } catch {
      // Keep the previous estimate if local telemetry cannot be persisted.
    }
    if (response.status === 200 || response.status === 201) {
      const item = uploadedFileSchema.parse(await response.json());
      input.onProgress?.(
        input.size,
        input.size,
        input.size,
        averageUploadBytesPerSecond,
      );
      return toAttachment(item, input);
    }
    uploadedBytes = end;
  }
  throw new Error("Upload session ended without a completed DriveItem.");
}

async function uploadChunkWithRetry(
  uploadUrl: string,
  chunk: Blob,
  start: number,
  end: number,
  total: number,
  signal: AbortSignal,
): Promise<{ response: Response; successfulAttemptDurationMs: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const startedAt = performance.now();
      const response = await fetch(uploadUrl, {
        method: "PUT",
        signal,
        headers: {
          "Content-Range": `bytes ${start}-${end - 1}/${total}`,
        },
        body: chunk,
      });
      if (response.ok) {
        return {
          response,
          successfulAttemptDurationMs: Math.max(
            performance.now() - startedAt,
            1,
          ),
        };
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(
          `File upload failed: ${await readGraphError(response)}`,
        );
      }
      lastError = new Error(await readGraphError(response));
    } catch (cause) {
      if (signal.aborted) throw cause;
      lastError = cause;
    }
    if (attempt < 2) await delay(500 * 2 ** attempt, signal);
  }
  throw new Error("File upload failed after three attempts.", {
    cause: lastError,
  });
}

async function prepareUploadFolder(
  accessToken: string,
  createdAtValue: string,
  messageId: string,
  signal: AbortSignal,
): Promise<string> {
  const root = await verifyAppFolder(signal);
  const createdAt = new Date(createdAtValue);
  const folderNames = [
    "files",
    createdAt.getUTCFullYear().toString(),
    (createdAt.getUTCMonth() + 1).toString().padStart(2, "0"),
    messageId,
  ];
  let parentId = root.id;
  for (const name of folderNames) {
    parentId = await ensureChildFolder(accessToken, parentId, name, signal);
  }
  return parentId;
}

function toAttachment(
  item: z.infer<typeof uploadedFileSchema>,
  input: {
    mimeType: string;
    imageWidth?: number;
    imageHeight?: number;
    thumbHash?: string;
  },
): Attachment {
  return {
    driveItemId: item.id,
    name: item.name,
    size: item.size,
    mimeType: input.mimeType || "application/octet-stream",
    ...(input.imageWidth ? { imageWidth: input.imageWidth } : {}),
    ...(input.imageHeight ? { imageHeight: input.imageHeight } : {}),
    ...(input.thumbHash ? { thumbHash: input.thumbHash } : {}),
  };
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function readImagePreview(
  driveItemId: string,
  mimeType: string,
): Promise<string> {
  if (!mimeType.startsWith("image/")) {
    throw new Error("OneDrop only creates inline previews for images.");
  }
  return readAttachmentDataUrl(driveItemId, mimeType);
}

export async function readAttachmentDataUrl(
  driveItemId: string,
  mimeType: string,
): Promise<string> {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(driveItemId)}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`Image preview failed: ${await readGraphError(response)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DIRECT_FILE_BYTES) {
    throw new Error("Attachment exceeds the current direct download limit.");
  }
  return `data:${mimeType || "application/octet-stream"};base64,${encodeBase64(bytes)}`;
}

export async function getAttachmentDownloadUrl(
  driveItemId: string,
): Promise<string> {
  const accessToken = await getCurrentAccessToken();
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

export async function getAttachmentWebUrl(
  driveItemId: string,
): Promise<string> {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(driveItemId)}?$select=webUrl`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `File location lookup failed: ${await readGraphError(response)}`,
    );
  }
  return attachmentWebSchema.parse(await response.json()).webUrl;
}

export async function checkAttachmentExists(
  driveItemId: string,
): Promise<boolean> {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(driveItemId)}?$select=id,file,deleted`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `Attached file check failed: ${await readGraphError(response)}`,
    );
  }
  return !attachmentStateSchema.parse(await response.json()).deleted;
}

async function ensureChildFolder(
  accessToken: string,
  parentId: string,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const lookup = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
    { signal, headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (lookup.ok) return folderSchema.parse(await lookup.json()).id;
  if (lookup.status !== 404) {
    throw new Error(
      `Upload folder lookup failed: ${await readGraphError(lookup)}`,
    );
  }

  const create = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}/children`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  if (create.ok) return folderSchema.parse(await create.json()).id;
  if (create.status === 409) {
    const raced = await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
      { signal, headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (raced.ok) return folderSchema.parse(await raced.json()).id;
  }
  throw new Error(
    `Upload folder creation failed: ${await readGraphError(create)}`,
  );
}

async function findExistingUpload(
  accessToken: string,
  parentId: string,
  name: string,
  expectedSize: number,
  signal: AbortSignal,
): Promise<z.infer<typeof uploadedFileSchema> | undefined> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
    { signal, headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Existing upload check failed: ${await readGraphError(response)}`,
    );
  }
  const item = uploadedFileSchema.parse(await response.json());
  return item.size === expectedSize ? item : undefined;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
