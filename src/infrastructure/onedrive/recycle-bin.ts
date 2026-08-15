import type { Message } from "../../domain/message";
import type {
  DeletedMessageItem,
  DeletedMessageKind,
} from "../../domain/deleted-message";
import type { MessageTombstone } from "../../domain/tombstone";
import { getOneDriveRuntime } from "../../platform/onedrive-runtime";
import { deleteMonthCache } from "../indexed-db/sync-cache";
import { enqueueDeletedDataMaintenance } from "./deleted-data-coordinator";
import { readRawMonthArchive } from "./month-archive";
import { readMonthSnapshot } from "./month-reader";
import {
  listMessageTombstonesWithAccessToken,
  removeMessageTombstoneWithAccessToken,
} from "./tombstones";

export function readDeletedMessages(): Promise<DeletedMessageItem[]> {
  return enqueueDeletedDataMaintenance(async () => {
    const accessToken = await getOneDriveRuntime().getAccessToken();
    const tombstones = await listMessageTombstonesWithAccessToken(accessToken);
    const messagesByMonth = new Map<string, Message[]>();
    const items: DeletedMessageItem[] = [];

    const months = [
      ...new Set(tombstones.map((tombstone) => tombstone.originalMonth)),
    ];
    for (let offset = 0; offset < months.length; offset += 4) {
      const batch = months.slice(offset, offset + 4);
      const results = await Promise.all(
        batch.map(async (month) => ({
          month,
          messages: await readRawMessages(month, accessToken),
        })),
      );
      for (const result of results) {
        messagesByMonth.set(result.month, result.messages);
      }
    }

    for (const tombstone of tombstones) {
      if (tombstone.recovery?.mode === "disabled") continue;
      const messages = messagesByMonth.get(tombstone.originalMonth) ?? [];
      const message = findUniqueMessage(messages, tombstone.messageId);
      // A missing message means cleanup has already won the race. Its stale
      // tombstone will be removed by cleanup and must not appear recoverable.
      if (!message) continue;
      items.push(toDeletedItem(tombstone, message));
    }

    return items.sort(
      (left, right) =>
        right.deletedAt.localeCompare(left.deletedAt) ||
        right.message.createdAt.localeCompare(left.message.createdAt),
    );
  });
}

export function restoreDeletedMessage(
  month: string,
  messageId: string,
): Promise<DeletedMessageItem> {
  return enqueueDeletedDataMaintenance(async () => {
    const accessToken = await getOneDriveRuntime().getAccessToken();
    const tombstone = (
      await listMessageTombstonesWithAccessToken(accessToken)
    ).find(
      (item) => item.originalMonth === month && item.messageId === messageId,
    );
    if (!tombstone) {
      throw new Error("This item is no longer in the recycle bin.");
    }
    const messages = await readRawMessages(month, accessToken);
    const message = findUniqueMessage(messages, messageId);
    if (!message) {
      throw new Error("This item has already been permanently deleted.");
    }
    await removeMessageTombstoneWithAccessToken(month, messageId, accessToken);
    await deleteMonthCache(month);
    return toDeletedItem(tombstone, message);
  });
}

async function readRawMessages(
  month: string,
  accessToken: string,
): Promise<Message[]> {
  const archive = await readRawMonthArchive(month, accessToken);
  const snapshot = await readMonthSnapshot(month, accessToken, true);
  const messages = [
    ...(archive?.document.messages ?? []),
    ...(snapshot.state === "loaded"
      ? snapshot.chunks.flatMap((chunk) => chunk.document.messages)
      : []),
  ];
  const candidates = new Map<
    string,
    { message: Message; serializations: Set<string> }
  >();
  for (const message of messages) {
    const serialized = JSON.stringify(message);
    const current = candidates.get(message.id);
    if (current) current.serializations.add(serialized);
    else
      candidates.set(message.id, {
        message,
        serializations: new Set([serialized]),
      });
  }
  return [...candidates.values()]
    .filter(({ serializations }) => serializations.size === 1)
    .map(({ message }) => message);
}

function findUniqueMessage(
  messages: Message[],
  messageId: string,
): Message | undefined {
  return messages.find((message) => message.id === messageId);
}

function toDeletedItem(
  tombstone: MessageTombstone,
  message: Message,
): DeletedMessageItem {
  const kind: DeletedMessageKind =
    message.type === "text"
      ? "text"
      : message.type === "file" &&
          (message.attachment.mimeType.startsWith("image/") ||
            message.attachment.imageWidth !== undefined)
        ? "image"
        : "file";
  return {
    message,
    originalMonth: tombstone.originalMonth,
    deletedAt: tombstone.deletedAt,
    kind,
    recovery:
      tombstone.recovery?.mode === "retention" &&
      tombstone.recovery.retention === "forever"
        ? "forever"
        : tombstone.recovery?.mode === "retention" &&
            tombstone.recovery.recoverableUntil
          ? tombstone.recovery.recoverableUntil
          : new Date(
              Date.parse(tombstone.deletedAt) + 10 * 86_400_000,
            ).toISOString(),
  };
}
