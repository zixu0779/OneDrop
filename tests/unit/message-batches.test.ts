import { describe, expect, it } from "vitest";

import type { Message } from "../../src/domain/message";
import {
  createMessageBatches,
  getVisibleMessages,
} from "../../src/features/messages/message-batches";

function text(index: number): Message {
  return {
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    type: "text",
    text: `Message ${index}`,
  };
}

function file(index: number): Message {
  return {
    schemaVersion: 1,
    id: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    type: "file",
    attachment: {
      driveItemId: `drive-${index}`,
      name: `${index}.png`,
      size: index,
      mimeType: "image/png",
    },
  };
}

describe("message batches", () => {
  it("loads 40 newest text messages and merges a tail shorter than 20", () => {
    expect(
      createMessageBatches(Array.from({ length: 59 }, (_, i) => text(i))),
    ).toEqual([Array.from({ length: 59 }, (_, i) => text(i))]);
    expect(
      createMessageBatches(Array.from({ length: 60 }, (_, i) => text(i))).map(
        (batch) => batch.length,
      ),
    ).toEqual([40, 20]);
  });

  it("ends at the attachment cap without skipping messages in the middle", () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      index % 2 === 0 ? file(index) : text(index),
    );
    const first = createMessageBatches(messages)[0]!;
    expect(first.filter((message) => message.type !== "text")).toHaveLength(10);
    expect(first).toEqual(messages.slice(39));
  });

  it("never inserts a later batch into the middle of an earlier batch", () => {
    const messages = [
      ...Array.from({ length: 45 }, (_, index) => file(index)),
      ...Array.from({ length: 10 }, (_, index) => text(index + 45)),
    ];
    const batches = createMessageBatches(messages);
    expect([...batches].reverse().flat()).toEqual(messages);
    expect(getVisibleMessages(messages, 1)).toEqual(batches[0]);
    expect(getVisibleMessages(messages, 2)).toEqual([
      ...batches[1]!,
      ...batches[0]!,
    ]);
  });

  it("reveals batches cumulatively in chronological order", () => {
    const messages = Array.from({ length: 100 }, (_, index) => text(index));
    expect(getVisibleMessages(messages, 1)).toEqual(messages.slice(60));
    expect(getVisibleMessages(messages, 2)).toEqual(messages.slice(20));
    expect(getVisibleMessages(messages, 3)).toEqual(messages);
  });
});
