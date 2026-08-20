import { z } from "zod";

import { oneDropConfig } from "@onedrop/core/config/onedrop";
import {
  tombstoneDocumentSchema,
  type MessageTombstone,
  type TombstoneDocument,
} from "@onedrop/core/domain/tombstone";
import { getCurrentAccessToken } from "@onedrop/app-runtime/features/auth/auth-service";
import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";
import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import { verifyAppFolderWithAccessToken } from "./app-folder";
import type { RecycleBinSetting } from "@onedrop/core/domain/settings";

const MAX_ATTEMPTS = 5;
const itemSchema = z.object({ id: z.string().min(1), eTag: z.string().min(1) });

export async function readTombstoneIds(
  month: string,
  accessToken: string,
): Promise<Set<string>> {
  const response = await fetch(tombstoneContentUrl(month), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return new Set();
  if (!response.ok) {
    throw new Error(
      `Message deletion records could not be read: ${await readGraphError(response)}`,
    );
  }
  const document = tombstoneDocumentSchema.parse(await response.json());
  if (document.month !== month) {
    throw new Error("The message deletion record belongs to another month.");
  }
  return new Set(document.tombstones.map((item) => item.messageId));
}

export async function writeMessageTombstone(
  month: string,
  messageId: string,
): Promise<void> {
  const accessToken = await getCurrentAccessToken();
  return writeMessageTombstoneWithAccessToken(month, messageId, accessToken);
}

export async function writeMessageTombstoneWithAccessToken(
  month: string,
  messageId: string,
  accessToken: string,
  recycle: RecycleBinSetting = {
    mode: "retention",
    retention: 10,
    updatedAt: new Date().toISOString(),
  },
): Promise<void> {
  await ensureTombstonesFolder(accessToken);
  const deletedAt = new Date();
  const tombstone: MessageTombstone = {
    schemaVersion: 1,
    messageId,
    originalMonth: month,
    deletedAt: deletedAt.toISOString(),
    recovery:
      recycle.mode === "disabled"
        ? { mode: "disabled" }
        : recycle.retention === "forever"
          ? { mode: "retention", retention: "forever" }
          : {
              mode: "retention",
              retention: recycle.retention,
              recoverableUntil: new Date(
                deletedAt.getTime() + recycle.retention * 86_400_000,
              ).toISOString(),
            },
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await readTombstoneDocument(month, accessToken);
    if (
      current?.document.tombstones.some((item) => item.messageId === messageId)
    ) {
      await deleteMonthCache(month);
      return;
    }
    const document = tombstoneDocumentSchema.parse({
      schemaVersion: 1,
      month,
      tombstones: [...(current?.document.tombstones ?? []), tombstone],
    });
    const response = current
      ? await updateDocument(
          accessToken,
          current.item.id,
          current.item.eTag,
          document,
        )
      : await createDocument(accessToken, month, document);
    if (response.status === 409 || response.status === 412) continue;
    if (!response.ok) {
      throw new Error(
        `Message deletion failed: ${await readGraphError(response)}`,
      );
    }
    itemSchema.parse(await response.json());
    await deleteMonthCache(month);
    return;
  }
  throw new Error("Message deletion records changed repeatedly. Try again.");
}

export async function listMessageTombstonesWithAccessToken(
  accessToken: string,
): Promise<MessageTombstone[]> {
  const folder = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/tombstones:/children?$select=id,name&$top=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (folder.status === 404) return [];
  if (!folder.ok) {
    throw new Error(
      `Message deletion records could not be listed: ${await readGraphError(folder)}`,
    );
  }
  const pageSchema = z.object({
    value: z.array(z.object({ id: z.string().min(1), name: z.string() })),
    "@odata.nextLink": z.string().url().optional(),
  });
  const tombstones: MessageTombstone[] = [];
  let page = pageSchema.parse(await folder.json());
  while (true) {
    for (const item of page.value) {
      if (!/^\d{4}-\d{2}\.json$/u.test(item.name)) continue;
      const response = await fetch(
        `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) {
        throw new Error(
          `Message deletion records could not be read: ${await readGraphError(response)}`,
        );
      }
      const document = tombstoneDocumentSchema.parse(await response.json());
      if (`${document.month}.json` !== item.name) {
        throw new Error("A message deletion record belongs to another month.");
      }
      tombstones.push(...document.tombstones);
    }
    if (!page["@odata.nextLink"]) break;
    if (!page["@odata.nextLink"].startsWith(`${oneDropConfig.graphBaseUrl}/`)) {
      throw new Error("OneDrive returned an invalid tombstone pagination URL.");
    }
    const next = await fetch(page["@odata.nextLink"], {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!next.ok) {
      throw new Error(
        `Message deletion records could not be listed: ${await readGraphError(next)}`,
      );
    }
    page = pageSchema.parse(await next.json());
  }
  return tombstones;
}

export async function removeMessageTombstoneWithAccessToken(
  month: string,
  messageId: string,
  accessToken: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await readTombstoneDocument(month, accessToken);
    if (!current) return;
    const tombstones = current.document.tombstones.filter(
      (item) => item.messageId !== messageId,
    );
    if (tombstones.length === current.document.tombstones.length) return;
    const response = await updateDocument(
      accessToken,
      current.item.id,
      current.item.eTag,
      { ...current.document, tombstones },
    );
    if (response.status === 409 || response.status === 412) continue;
    if (!response.ok) {
      throw new Error(
        `Message restoration failed: ${await readGraphError(response)}`,
      );
    }
    await deleteMonthCache(month);
    return;
  }
  throw new Error("Message deletion records changed repeatedly. Try again.");
}

async function readTombstoneDocument(
  month: string,
  accessToken: string,
): Promise<
  { item: z.infer<typeof itemSchema>; document: TombstoneDocument } | undefined
> {
  const metadata = await fetch(tombstoneItemUrl(month), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (metadata.status === 404) return undefined;
  if (!metadata.ok) {
    throw new Error(
      `Message deletion record lookup failed: ${await readGraphError(metadata)}`,
    );
  }
  const item = itemSchema.parse(await metadata.json());
  const content = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(item.id)}/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!content.ok) {
    throw new Error(
      `Message deletion records could not be read: ${await readGraphError(content)}`,
    );
  }
  const document = tombstoneDocumentSchema.parse(await content.json());
  if (document.month !== month) {
    throw new Error("The message deletion record belongs to another month.");
  }
  return { item, document };
}

async function ensureTombstonesFolder(accessToken: string): Promise<void> {
  const existing = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/tombstones`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `Tombstones folder lookup failed: ${await readGraphError(existing)}`,
    );
  }
  const appRoot = await verifyAppFolderWithAccessToken(accessToken);
  const created = await fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(appRoot.id)}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "tombstones",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );
  if (created.ok || created.status === 409) return;
  throw new Error(
    `Tombstones folder creation failed: ${await readGraphError(created)}`,
  );
}

function createDocument(
  accessToken: string,
  month: string,
  document: TombstoneDocument,
): Promise<Response> {
  const conflictBehavior = encodeURIComponent(
    "@microsoft.graph.conflictBehavior",
  );
  return fetch(`${tombstoneContentUrl(month)}?${conflictBehavior}=fail`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(document, null, 2),
  });
}

function updateDocument(
  accessToken: string,
  itemId: string,
  eTag: string,
  document: TombstoneDocument,
): Promise<Response> {
  return fetch(
    `${oneDropConfig.graphBaseUrl}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
        "If-Match": eTag,
      },
      body: JSON.stringify(document, null, 2),
    },
  );
}

function tombstoneItemUrl(month: string): string {
  return `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/tombstones/${month}.json`;
}

function tombstoneContentUrl(month: string): string {
  return `${tombstoneItemUrl(month)}:/content`;
}
