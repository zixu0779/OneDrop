import { describe, expect, it } from "vitest";

import { monthDocumentSchema } from "../../src/domain/month-document";

describe("monthDocumentSchema", () => {
  it("accepts an empty monthly document", () => {
    const result = monthDocumentSchema.safeParse({
      schemaVersion: 1,
      month: "2026-08",
      messages: [],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a non-month partition", () => {
    const result = monthDocumentSchema.safeParse({
      schemaVersion: 1,
      month: "2026-08-02",
      messages: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects corrupted remote message data", () => {
    const result = monthDocumentSchema.safeParse({
      schemaVersion: 1,
      month: "2026-08",
      messages: [{ schemaVersion: 1, id: "not-a-uuid", type: "text" }],
    });

    expect(result.success).toBe(false);
  });
});
