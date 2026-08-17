import { describe, expect, it } from "vitest";

import { createTextMessage } from "@onedrop/core/features/messages/create-text-message";
import {
  getMessageLines,
  serializeMonthDocument,
} from "@onedrop/onedrive/infrastructure/onedrive/month-serialization";

describe("month document serialization", () => {
  it("writes stable multiline JSON and records real message lines", () => {
    const first = createTextMessage(
      "first",
      new Date("2026-08-08T00:00:00.000Z"),
      "01989f5e-7700-7000-8000-000000000061",
    );
    const second = createTextMessage(
      "second",
      new Date("2026-08-08T00:01:00.000Z"),
      "01989f5e-7700-7000-8000-000000000062",
    );
    const document = {
      schemaVersion: 1 as const,
      month: "2026-08",
      messages: [first, second],
    };

    const serialized = serializeMonthDocument(document);
    const lines = getMessageLines(serialized, document);

    expect(serialized).toContain("\n");
    expect(lines[first.id]).toBeGreaterThan(1);
    expect(lines[second.id]).toBeGreaterThan(lines[first.id]!);
  });
});
