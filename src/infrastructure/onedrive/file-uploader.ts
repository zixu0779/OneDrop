import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import { MAX_DIRECT_FILE_BYTES } from "../../config/files";
import type { Attachment } from "../../domain/message";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
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
    const root = await verifyAppFolder(controller.signal);
    const createdAt = new Date(input.createdAt);
    const folderNames = [
      "files",
      createdAt.getUTCFullYear().toString(),
      (createdAt.getUTCMonth() + 1).toString().padStart(2, "0"),
      input.messageId,
    ];
    let parentId = root.id;
    for (const name of folderNames) {
      parentId = await ensureChildFolder(
        accessToken,
        parentId,
        name,
        controller.signal,
      );
    }

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
