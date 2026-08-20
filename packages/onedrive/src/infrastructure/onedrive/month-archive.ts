import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import {
  monthDocumentSchema,
  type MonthDocument,
} from "@onedrop/core/domain/month-document";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";
import { verifyAppFolder } from "./app-folder";
import { serializeMonthDocument } from "./month-serialization";
import { readTombstoneIds } from "./tombstones";

const itemSchema = z.object({
  id: z.string().min(1),
  eTag: z.string().min(1),
});

export type MonthArchive = {
  itemId: string;
  eTag: string;
  document: MonthDocument;
};

export function isMonthArchiveEligible(
  month: string,
  now = new Date(),
): boolean {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (!match) return false;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return false;
  const graceEndsAt = Date.UTC(year, monthIndex + 1, 2);
  return now.getTime() >= graceEndsAt;
}

export async function readMonthArchive(
  month: string,
  accessToken: string,
): Promise<MonthArchive | undefined> {
  const archive = await readRawMonthArchive(month, accessToken);
  if (!archive) return undefined;
  const deletedIds = await readTombstoneIds(month, accessToken);
  return {
    ...archive,
    document: monthDocumentSchema.parse({
      ...archive.document,
      messages: archive.document.messages.filter(
        (message) => !deletedIds.has(message.id),
      ),
    }),
  };
}

export async function readRawMonthArchive(
  month: string,
  accessToken: string,
): Promise<MonthArchive | undefined> {
  const metadata = await fetch(archiveItemUrl(month), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (metadata.status === 404) return undefined;
  if (!metadata.ok) {
    throw new Error(
      `Month archive lookup failed: ${await readGraphError(metadata)}`,
    );
  }
  const item = itemSchema.parse(await metadata.json());
  const content = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!content.ok) {
    throw new Error(
      `Month archive download failed: ${await readGraphError(content)}`,
    );
  }
  const document = monthDocumentSchema.parse(await content.json());
  if (document.month !== month) {
    throw new Error("The month archive belongs to another month.");
  }
  return {
    itemId: item.id,
    eTag: item.eTag,
    document,
  };
}

export async function publishMonthArchive(
  document: MonthDocument,
  accessToken: string,
): Promise<MonthArchive> {
  await ensureArchiveFolder(accessToken);
  const conflictBehavior = encodeURIComponent(
    "@microsoft.graph.conflictBehavior",
  );
  const response = await fetch(
    `${archiveContentUrl(document.month)}?${conflictBehavior}=fail`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: serializeMonthDocument(document),
    },
  );
  if (response.status !== 409 && !response.ok) {
    throw new Error(
      `Month archive publication failed: ${await readGraphError(response)}`,
    );
  }
  const published = await readMonthArchive(document.month, accessToken);
  if (!published) throw new Error("The published month archive is missing.");
  if (
    serializeMonthDocument(published.document) !==
    serializeMonthDocument(document)
  ) {
    throw new Error("The published month archive failed verification.");
  }
  return published;
}

async function ensureArchiveFolder(accessToken: string): Promise<void> {
  const existing = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/archive`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `Archive folder lookup failed: ${await readGraphError(existing)}`,
    );
  }
  const appRoot = await verifyAppFolder();
  const created = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(appRoot.id)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "archive",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  if (created.ok || created.status === 409) return;
  throw new Error(
    `Archive folder creation failed: ${await readGraphError(created)}`,
  );
}

function archiveItemUrl(month: string): string {
  return `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/archive/${month}.json`;
}

function archiveContentUrl(month: string): string {
  return `${archiveItemUrl(month)}:/content`;
}
