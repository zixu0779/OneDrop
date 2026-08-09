import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import {
  tombstoneDocumentSchema,
  type MessageTombstone,
  type TombstoneDocument,
} from "../../domain/tombstone";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import { deleteMonthCache } from "../indexed-db/sync-cache";
import { verifyAppFolder } from "./app-folder";

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
  await ensureTombstonesFolder(accessToken);
  const tombstone: MessageTombstone = {
    schemaVersion: 1,
    messageId,
    originalMonth: month,
    deletedAt: new Date().toISOString(),
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
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/tombstones`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `Tombstones folder lookup failed: ${await readGraphError(existing)}`,
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
  return `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/tombstones/${month}.json`;
}

function tombstoneContentUrl(month: string): string {
  return `${tombstoneItemUrl(month)}:/content`;
}
