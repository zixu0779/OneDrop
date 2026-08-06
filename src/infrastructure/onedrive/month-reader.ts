import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type { MonthReadResult } from "../../contracts/runtime-messages";
import { monthDocumentSchema } from "../../domain/month-document";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import {
  deleteMonthCache,
  getMonthCache,
  putMonthCache,
} from "../indexed-db/sync-cache";

const monthPattern = /^\d{4}-\d{2}$/u;

const driveItemSchema = z.object({
  id: z.string().min(1),
  eTag: z.string().min(1),
});

export type MonthSnapshot =
  | { state: "missing"; month: string }
  | {
      state: "loaded";
      month: string;
      itemId: string;
      eTag: string;
      document: z.infer<typeof monthDocumentSchema>;
    };

export async function readMonthDocument(
  month: string,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  const snapshot = await readMonthSnapshot(month, accessToken);

  return snapshot.state === "missing"
    ? snapshot
    : {
        state: "loaded",
        month: snapshot.month,
        eTag: snapshot.eTag,
        messages: snapshot.document.messages,
      };
}

export async function readMonthSnapshot(
  month: string,
  accessToken: string,
): Promise<MonthSnapshot> {
  if (!monthPattern.test(month)) {
    throw new Error("OneDrop received an invalid UTC month partition.");
  }

  const cached = await getCachedMonthSnapshot(month);
  const itemPath = `/messages/${month}.json`;
  const metadataResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:${itemPath}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(cached ? { "If-None-Match": cached.eTag } : {}),
      },
    },
  );

  if (metadataResponse.status === 304 && cached) {
    return cached;
  }

  if (metadataResponse.status === 404) {
    await deleteMonthCache(month);
    return { state: "missing", month };
  }

  if (!metadataResponse.ok) {
    const error = await readGraphError(metadataResponse);
    throw new Error(`Monthly message metadata lookup failed: ${error}`);
  }

  const item = driveItemSchema.parse(await metadataResponse.json());
  const contentResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!contentResponse.ok) {
    const error = await readGraphError(contentResponse);
    throw new Error(`Monthly message download failed: ${error}`);
  }

  const document = monthDocumentSchema.parse(await contentResponse.json());

  if (document.month !== month) {
    throw new Error(
      `Monthly message document mismatch: expected ${month}, received ${document.month}.`,
    );
  }

  await putMonthCache({
    month,
    itemId: item.id,
    eTag: item.eTag,
    document,
  });

  return {
    state: "loaded",
    month,
    itemId: item.id,
    eTag: item.eTag,
    document,
  };
}

export async function getCachedMonthSnapshot(
  month: string,
): Promise<Extract<MonthSnapshot, { state: "loaded" }> | undefined> {
  const cached = await getMonthCache(month);

  if (!cached) return undefined;

  const parsed = monthDocumentSchema.safeParse(cached.document);

  if (!parsed.success || parsed.data.month !== month) {
    await deleteMonthCache(month);
    return undefined;
  }

  return {
    state: "loaded",
    month,
    itemId: cached.itemId,
    eTag: cached.eTag,
    document: parsed.data,
  };
}
