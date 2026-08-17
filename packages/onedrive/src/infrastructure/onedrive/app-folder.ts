import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import type { AppFolderSummary } from "@onedrop/core/contracts/runtime-messages";
import { getCurrentAccessToken } from "@onedrop/app-runtime/features/auth/auth-service";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";

const driveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  webUrl: z.url().optional(),
  specialFolder: z
    .object({
      name: z.string(),
    })
    .optional(),
});

export async function verifyAppFolder(
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const accessToken = await getCurrentAccessToken();
  return verifyAppFolderWithAccessToken(accessToken, signal);
}

export async function verifyAppFolderWithAccessToken(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}`,
    {
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const message = await readGraphError(response);
    throw new Error(`OneDrive App Folder check failed: ${message}`);
  }

  return parseAppFolder(await response.json());
}

export function parseAppFolder(value: unknown): AppFolderSummary {
  const item = driveItemSchema.parse(value);

  return {
    id: item.id,
    name: item.name,
    ...(item.webUrl ? { webUrl: item.webUrl } : {}),
  };
}
