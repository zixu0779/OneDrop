import { z } from "zod";

import { oneDropConfig } from "../../config/onedrop";
import type { MonthReadResult } from "../../contracts/runtime-messages";
import { monthDocumentSchema } from "../../domain/month-document";
import type { Message, TextMessage } from "../../domain/message";
import { getCurrentAccessToken } from "../../features/auth/auth-service";
import { readGraphError } from "../graph/graph-error";
import {
  deleteMessagesFolderId,
  deleteMonthCache,
  getMessagesFolderId,
  putMessagesFolderId,
  putMonthCache,
} from "../indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readMonthSnapshot,
  type MonthSnapshot,
} from "./month-reader";

const MAX_ATTEMPTS = 5;
const MAX_MONTH_BYTES = 10 * 1024 * 1024;

const writtenItemSchema = z.object({
  id: z.string().min(1),
  eTag: z.string().min(1),
});
const folderItemSchema = z.object({
  id: z.string().min(1),
  folder: z.object({ childCount: z.number().int().nonnegative().optional() }),
});

export async function appendTextMessage(
  month: string,
  message: TextMessage,
): Promise<MonthReadResult> {
  const accessToken = await getCurrentAccessToken();
  await ensureMessagesFolder(accessToken);
  let snapshot: MonthSnapshot | undefined = await getCachedMonthSnapshot(month);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    snapshot ??= await readMonthSnapshot(month, accessToken);
    const existingMessages =
      snapshot.state === "loaded" ? snapshot.document.messages : [];

    const merged = mergeTextMessage(month, existingMessages, message);

    if (!merged.added) {
      if (snapshot.state === "missing") return snapshot;
      return {
        state: "loaded",
        month,
        eTag: snapshot.eTag,
        messages: snapshot.document.messages,
      };
    }

    const document = merged.document;
    const body = JSON.stringify(document);

    if (new TextEncoder().encode(body).byteLength > MAX_MONTH_BYTES) {
      throw new Error(
        "The current monthly message document reached its 10 MB limit.",
      );
    }

    let response: Response;

    try {
      response =
        snapshot.state === "missing"
          ? await createMonth(accessToken, month, body)
          : await updateMonth(
              accessToken,
              snapshot.itemId,
              snapshot.eTag,
              body,
            );
    } catch (error) {
      // The request may have reached OneDrive even when the client never
      // received its response. Invalidate the snapshot, but never replay an
      // ambiguous write automatically.
      await deleteMonthCache(month);
      throw error;
    }

    if (response.status === 409 || response.status === 412) {
      await deleteMonthCache(month);
      snapshot = undefined;
      continue;
    }

    if (response.status === 404) {
      await Promise.all([deleteMonthCache(month), deleteMessagesFolderId()]);
      await ensureMessagesFolder(accessToken);
      snapshot = undefined;
      continue;
    }

    if (!response.ok) {
      const error = await readGraphError(response);
      throw new Error(`Monthly message write failed: ${error}`);
    }

    const item = writtenItemSchema.parse(await response.json());
    await putMonthCache({
      month,
      itemId: item.id,
      eTag: item.eTag,
      document,
    });
    return {
      state: "loaded",
      month,
      eTag: item.eTag,
      messages: document.messages,
    };
  }

  throw new Error(
    "The monthly message document changed repeatedly. Try sending again.",
  );
}

export function mergeTextMessage(
  month: string,
  existingMessages: Message[],
  message: TextMessage,
): {
  added: boolean;
  document: z.infer<typeof monthDocumentSchema>;
} {
  const added = !existingMessages.some((item) => item.id === message.id);
  return {
    added,
    document: monthDocumentSchema.parse({
      schemaVersion: 1,
      month,
      messages: added ? [...existingMessages, message] : existingMessages,
    }),
  };
}

async function ensureMessagesFolder(accessToken: string): Promise<void> {
  if (await getMessagesFolderId()) return;

  const existingResponse = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (existingResponse.ok) {
    const folder = folderItemSchema.parse(await existingResponse.json());
    await putMessagesFolderId(folder.id);
    return;
  }

  if (existingResponse.status !== 404) {
    const error = await readGraphError(existingResponse);
    throw new Error(`Messages folder lookup failed: ${error}`);
  }

  const response = await fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}/children`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "messages",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    },
  );

  if (response.ok) {
    const folder = folderItemSchema.parse(await response.json());
    await putMessagesFolderId(folder.id);
    return;
  }

  if (response.status === 409) {
    const racedResponse = await fetch(
      `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (racedResponse.ok) {
      const folder = folderItemSchema.parse(await racedResponse.json());
      await putMessagesFolderId(folder.id);
      return;
    }
  }

  const error = await readGraphError(response);
  throw new Error(`Messages folder creation failed: ${error}`);
}

function createMonth(
  accessToken: string,
  month: string,
  body: string,
): Promise<Response> {
  const conflictBehavior = encodeURIComponent(
    "@microsoft.graph.conflictBehavior",
  );
  return fetch(
    `${oneDropConfig.graphBaseUrl}${oneDropConfig.appRootPath}:/messages/${month}.json:/content?${conflictBehavior}=fail`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    },
  );
}

function updateMonth(
  accessToken: string,
  itemId: string,
  eTag: string,
  body: string,
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
      body,
    },
  );
}
