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

export async function uploadSmallFile(input: {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
  messageId: string;
  createdAt: string;
}): Promise<Attachment> {
  if (input.size > MAX_DIRECT_FILE_BYTES) {
    throw new Error("Large-file upload sessions are not implemented yet.");
  }

  const bytes = decodeBase64(input.base64);
  if (bytes.byteLength !== input.size) {
    throw new Error("The selected file changed before upload.");
  }

  const accessToken = await getCurrentAccessToken();
  const root = await verifyAppFolder();
  const createdAt = new Date(input.createdAt);
  const folderNames = [
    "files",
    createdAt.getUTCFullYear().toString(),
    (createdAt.getUTCMonth() + 1).toString().padStart(2, "0"),
    input.messageId,
  ];
  let parentId = root.id;
  for (const name of folderNames) {
    parentId = await ensureChildFolder(accessToken, parentId, name);
  }

  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(input.name)}:/content`,
    {
      method: "PUT",
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
  };
}

async function ensureChildFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<string> {
  const lookup = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
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
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (raced.ok) return folderSchema.parse(await raced.json()).id;
  }
  throw new Error(
    `Upload folder creation failed: ${await readGraphError(create)}`,
  );
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
