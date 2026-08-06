import { describe, expect, it } from "vitest";

import { createTextMessage } from "../../src/features/messages/create-text-message";

describe("createTextMessage", () => {
  it("creates a versioned UTF-8 text message", () => {
    expect(
      createTextMessage(
        "  你好，OneDrop  ",
        new Date("2026-08-02T10:00:00.000Z"),
        "01989f5e-7700-7000-8000-000000000001",
      ),
    ).toEqual({
      schemaVersion: 1,
      id: "01989f5e-7700-7000-8000-000000000001",
      type: "text",
      createdAt: "2026-08-02T10:00:00.000Z",
      text: "你好，OneDrop",
    });
  });

  it("rejects blank text", () => {
    expect(() =>
      createTextMessage(
        "   ",
        new Date("2026-08-02T10:00:00.000Z"),
        "01989f5e-7700-7000-8000-000000000001",
      ),
    ).toThrow();
  });
});
