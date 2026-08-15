import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";

const parentSchema = z.object({
  parentReference: z.object({ id: z.string().min(1) }),
});
const folderSchema = z.object({ webUrl: z.url() });

export async function deleteCorruptMonthFile(itemId: string): Promise<void> {
  return deleteCorruptMonthFileWithAccessToken(
    itemId,
    await getCurrentAccessToken(),
  );
}

export async function deleteCorruptMonthFileWithAccessToken(
  itemId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Damaged record deletion failed: ${await readGraphError(response)}`,
    );
  }
}

export async function getCorruptMonthFileFolderUrl(
  itemId: string,
): Promise<string> {
  return getCorruptMonthFileFolderUrlWithAccessToken(
    itemId,
    await getCurrentAccessToken(),
  );
}

export async function getCorruptMonthFileFolderUrlWithAccessToken(
  itemId: string,
  accessToken: string,
): Promise<string> {
  const itemResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}?$select=parentReference`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!itemResponse.ok) {
    throw new Error(
      `Record location lookup failed: ${await readGraphError(itemResponse)}`,
    );
  }
  const parentId = parentSchema.parse(await itemResponse.json()).parentReference
    .id;
  const folderResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(parentId)}?$select=webUrl`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!folderResponse.ok) {
    throw new Error(
      `Record folder lookup failed: ${await readGraphError(folderResponse)}`,
    );
  }
  return folderSchema.parse(await folderResponse.json()).webUrl;
}
