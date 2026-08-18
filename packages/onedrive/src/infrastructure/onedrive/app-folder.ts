import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import type { AppFolderSummary } from "@onedrop/core/contracts/runtime-messages";
import { getCurrentAccessToken } from "@onedrop/app-runtime/features/auth/auth-service";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";

// OneDrive can take a short time to provision the special App Folder after
// the previous folder was deleted. Treat that initial 404 as transient.
const APP_FOLDER_RETRY_DELAYS_MS = [100, 300, 900] as const;
const APP_FOLDER_PROBE_PREFIX = ".onedrop-app-folder-probe-";

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
const probeItemSchema = z.object({
  id: z.string().min(1),
  parentReference: z.object({ id: z.string().min(1) }).optional(),
});

const inFlightChecks = new Map<
  string,
  Promise<AppFolderSummary>
>();

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
  // Startup reads settings, messages, and the explicit folder check in
  // parallel. Share the no-signal check so they do not multiply a transient
  // App Folder recovery into a burst of identical Graph requests.
  if (!signal) {
    const inFlight = inFlightChecks.get(accessToken);
    if (inFlight) return inFlight;
    const check = verifyAppFolderUnshared(accessToken);
    inFlightChecks.set(accessToken, check);
    void check
      .finally(() => {
        if (inFlightChecks.get(accessToken) === check) {
          inFlightChecks.delete(accessToken);
        }
      })
      .catch(() => undefined);
    return check;
  }
  return verifyAppFolderUnshared(accessToken, signal);
}

async function verifyAppFolderUnshared(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}`,
      {
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (response.ok) return parseAppFolder(await response.json());
    const retryDelay =
      response.status === 404
        ? APP_FOLDER_RETRY_DELAYS_MS[attempt]
        : undefined;
    if (retryDelay === undefined) break;
    await waitForRetry(retryDelay, signal);
  }

  if (response.status === 404) {
    return provisionAppFolder(accessToken, signal);
  }

  if (!response.ok) {
    const message = await readGraphError(response);
    throw new Error(`OneDrive App Folder check failed: ${message}`);
  }

  return parseAppFolder(await response.json());
}

async function provisionAppFolder(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AppFolderSummary> {
  const probeName = `${APP_FOLDER_PROBE_PREFIX}${crypto.randomUUID()}.tmp`;
  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/${encodeURIComponent(probeName)}:/content`,
    {
      method: "PUT",
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Blob(),
    },
  );
  if (!response.ok) {
    const message = await readGraphError(response);
    throw new Error(`OneDrive App Folder initialization failed: ${message}`);
  }

  const probe = probeItemSchema.parse(await response.json());
  try {
    const root = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}`,
      {
        ...(signal ? { signal } : {}),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (root.ok) return parseAppFolder(await root.json());
    if (root.status !== 404) {
      const message = await readGraphError(root);
      throw new Error(`OneDrive App Folder check failed: ${message}`);
    }
    const rootId = probe.parentReference?.id;
    if (rootId) return { id: rootId, name: "OneDrop" };
    throw new Error("OneDrive did not return the App Folder parent ID.");
  } finally {
    await fetch(
      `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(probe.id)}`,
      {
        method: "DELETE",
        ...(signal ? { signal } : {}),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    ).catch(() => undefined);
  }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export function parseAppFolder(value: unknown): AppFolderSummary {
  const item = driveItemSchema.parse(value);

  return {
    id: item.id,
    name: item.name,
    ...(item.webUrl ? { webUrl: item.webUrl } : {}),
  };
}
