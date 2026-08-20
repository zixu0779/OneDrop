import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import type { AppFolderSummary } from "@onedrop/core/contracts/runtime-messages";
import { getCurrentAccessToken } from "@onedrop/app-runtime/features/auth/auth-service";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";

const APPS_FOLDER_NAME = "Apps";
const APP_FOLDER_NAME = "OneDrop";

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
const driveItemCollectionSchema = z.object({
  value: z.array(driveItemSchema),
});

const inFlightChecks = new Map<string, Promise<AppFolderSummary>>();

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
  // Startup reads settings, messages, pending transfers, and the explicit
  // folder check in parallel. Some callers have their own AbortSignal, but
  // allowing those calls to provision independently can create OneDrop and
  // OneDrop 1 at the same time. Keep one non-cancellable cloud operation per
  // token and only cancel an individual caller's wait.
  let check = inFlightChecks.get(accessToken);
  if (!check) {
    check = verifyAppFolderUnshared(accessToken);
    inFlightChecks.set(accessToken, check);
    void check
      .finally(() => {
        if (inFlightChecks.get(accessToken) === check) {
          inFlightChecks.delete(accessToken);
        }
      })
      .catch(() => undefined);
  }
  return signal ? waitForSharedCheck(check, signal) : check;
}

function waitForSharedCheck(
  check: Promise<AppFolderSummary>,
  signal: AbortSignal,
): Promise<AppFolderSummary> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void check.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function verifyAppFolderUnshared(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}`,
    {
      ...(signal ? { signal } : {}),
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (response.ok) return parseAppFolder(await response.json());
  if (response.status === 404) {
    return provisionAppFolder(accessToken, signal);
  }

  const message = await readGraphError(response);
  throw new Error(`OneDrive App Folder check failed: ${message}`);
}

async function provisionAppFolder(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const apps = await ensureFolder(
    accessToken,
    "/me/drive/root",
    APPS_FOLDER_NAME,
    signal,
  );
  return ensureFolder(
    accessToken,
    `/me/drive/items/${encodeURIComponent(apps.id)}`,
    APP_FOLDER_NAME,
    signal,
  );
}

async function ensureFolder(
  accessToken: string,
  parentPath: string,
  name: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${parentPath}/children`,
    {
      method: "POST",
      ...(signal ? { signal } : {}),
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

  if (response.ok) return parseAppFolder(await response.json());
  if (response.status === 409) {
    const children = await fetch(
      `${oneDropConfig.graphBaseUrl}${parentPath}/children?$select=id,name,webUrl`,
      {
        ...(signal ? { signal } : {}),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (children.ok) {
      const match = driveItemCollectionSchema
        .parse(await children.json())
        .value.find((item) => item.name === name);
      if (match) return parseAppFolder(match);
    }
  }

  const message = await readGraphError(response);
  throw new Error(`OneDrive folder initialization failed: ${message}`);
}

export function parseAppFolder(value: unknown): AppFolderSummary {
  const item = driveItemSchema.parse(value);

  return {
    id: item.id,
    name: item.name,
    ...(item.webUrl ? { webUrl: item.webUrl } : {}),
  };
}
