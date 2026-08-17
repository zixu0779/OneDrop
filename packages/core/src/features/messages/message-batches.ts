export const MESSAGE_BATCH_TARGET = 40;
export const MESSAGE_BATCH_ATTACHMENT_LIMIT = 10;
export const MESSAGE_BATCH_TAIL_MERGE_THRESHOLD = 20;

export type MessageBatchItem = {
  id: string;
  type: string;
};

export function createMessageBatches<T extends MessageBatchItem>(
  messages: T[],
): T[][] {
  const remaining = [...messages];
  const newestFirstBatches: T[][] = [];

  while (remaining.length > 0) {
    let batchStart = remaining.length;
    let attachmentCount = 0;

    for (
      let index = remaining.length - 1;
      index >= 0 && remaining.length - batchStart < MESSAGE_BATCH_TARGET;
      index -= 1
    ) {
      const message = remaining[index]!;
      if (message.type !== "text") {
        if (attachmentCount >= MESSAGE_BATCH_ATTACHMENT_LIMIT) break;
        attachmentCount += 1;
      }
      batchStart = index;
    }

    const batch = remaining.slice(batchStart);
    const nextRemaining = remaining.slice(0, batchStart);

    if (nextRemaining.length < MESSAGE_BATCH_TAIL_MERGE_THRESHOLD) {
      newestFirstBatches.push([...nextRemaining, ...batch]);
      break;
    }

    newestFirstBatches.push(batch);
    remaining.splice(0, remaining.length, ...nextRemaining);
  }

  return newestFirstBatches;
}

export function getVisibleMessages<T extends MessageBatchItem>(
  messages: T[],
  visibleBatchCount: number,
): T[] {
  const visibleIds = new Set(
    createMessageBatches(messages)
      .slice(0, Math.max(1, visibleBatchCount))
      .flat()
      .map((message) => message.id),
  );
  return messages.filter((message) => visibleIds.has(message.id));
}
