import { describe, expect, it } from "vitest";

import { createTextMessage } from "../../src/features/messages/create-text-message";
import { mergeTextMessage } from "../../src/infrastructure/onedrive/month-writer";

const message = createTextMessage(
  "idempotent",
  new Date("2026-08-02T10:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000001",
);

describe("mergeTextMessage", () => {
  it("adds a message to the monthly document", () => {
    const result = mergeTextMessage("2026-08", [], message);

    expect(result.added).toBe(true);
    expect(result.document.messages).toEqual([message]);
  });

  it("deduplicates a retried message by ID", () => {
    const result = mergeTextMessage("2026-08", [message], message);

    expect(result.added).toBe(false);
    expect(result.document.messages).toEqual([message]);
  });
});
