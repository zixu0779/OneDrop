import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type { MonthReadResult } from "../../contracts/runtime-messages";
import { monthDocumentSchema } from "../../domain/month-document";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";

const monthPattern = /^\d{4}-\d{2}$/u;

const driveItemSchema = z.object({
  id: z.string().min(1),
  eTag: z.string().min(1),
});

export async function readMonthDocument(
  month: string,
): Promise<MonthReadResult> {
  if (!monthPattern.test(month)) {
    throw new Error("OneDrop received an invalid UTC month partition.");
  }

  const accessToken = await getCurrentAccessToken();
  const itemPath = `/messages/${month}.json`;
  const metadataResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:${itemPath}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (metadataResponse.status === 404) {
    return { state: "missing", month };
  }

  if (!metadataResponse.ok) {
    const message = await readGraphError(metadataResponse);
    throw new Error(`Monthly message metadata lookup failed: ${message}`);
  }

  const item = driveItemSchema.parse(await metadataResponse.json());
  const contentResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!contentResponse.ok) {
    const message = await readGraphError(contentResponse);
    throw new Error(`Monthly message download failed: ${message}`);
  }

  const document = monthDocumentSchema.parse(await contentResponse.json());

  if (document.month !== month) {
    throw new Error(
      `Monthly message document mismatch: expected ${month}, received ${document.month}.`,
    );
  }

  return {
    state: "loaded",
    month,
    eTag: item.eTag,
    messages: document.messages,
  };
}
