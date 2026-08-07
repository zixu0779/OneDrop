import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("../../src/infrastructure/indexed-db/sync-cache", () => ({
  deleteMessagesFolderId: vi.fn().mockResolvedValue(undefined),
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
  getMessagesFolderId: vi.fn().mockResolvedValue("messages-folder-id"),
  putMessagesFolderId: vi.fn().mockResolvedValue(undefined),
  putMonthCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/infrastructure/onedrive/month-reader", () => ({
  getCachedMonthSnapshot: vi.fn(),
  readMonthSnapshot: vi.fn(),
}));

import { createTextMessage } from "../../src/features/messages/create-text-message";
import { deleteMonthCache } from "../../src/infrastructure/indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readMonthSnapshot,
} from "../../src/infrastructure/onedrive/month-reader";
import { appendTextMessage } from "../../src/infrastructure/onedrive/month-writer";

const first = createTextMessage(
  "first",
  new Date("2026-08-02T10:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000001",
);
const second = createTextMessage(
  "second",
  new Date("2026-08-02T10:00:01.000Z"),
  "01989f5e-7700-7000-8000-000000000002",
);

function largeMessages() {
  return Array.from({ length: 14 }, (_, index) =>
    createTextMessage(
      "x".repeat(20_000),
      new Date(Date.UTC(2026, 7, 2, 10, 0, index)),
      `01989f5e-7700-7000-8000-${(index + 10).toString().padStart(12, "0")}`,
    ),
  );
}

function loaded(eTag: string, messages = [first]) {
  return {
    state: "loaded" as const,
    month: "2026-08",
    itemId: "month-item-id",
    eTag,
    document: { schemaVersion: 1 as const, month: "2026-08", messages },
    chunks: [
      {
        index: 1,
        itemId: "month-item-id",
        eTag,
        document: {
          schemaVersion: 1 as const,
          month: "2026-08",
          messages,
        },
      },
    ],
  };
}

describe("appendTextMessage conflict recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-reads and merges after a 412 ETag conflict", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(loaded("etag-1"));
    vi.mocked(readMonthSnapshot).mockResolvedValue(loaded("etag-2", [first]));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 412 }))
        .mockResolvedValueOnce(
          Response.json(
            { id: "month-item-id", eTag: "etag-3" },
            { status: 200 },
          ),
        ),
    );

    const result = await appendTextMessage("2026-08", second);

    expect(result.state).toBe("loaded");
    if (result.state === "loaded") {
      expect(result.messages).toEqual([first, second]);
      expect(result.eTag).toBe("etag-3");
    }
    expect(readMonthSnapshot).toHaveBeenCalledTimes(1);
  });

  it("recovers when another device wins initial creation with 409", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot)
      .mockResolvedValueOnce({ state: "missing", month: "2026-08" })
      .mockResolvedValueOnce(loaded("etag-1", [first]));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 409 }))
        .mockResolvedValueOnce(
          Response.json(
            { id: "month-item-id", eTag: "etag-2" },
            { status: 200 },
          ),
        ),
    );

    const result = await appendTextMessage("2026-08", second);

    expect(result.state).toBe("loaded");
    if (result.state === "loaded") {
      expect(result.messages).toEqual([first, second]);
    }
  });

  it("creates the deterministic next chunk after the soft size target", async () => {
    const messages = largeMessages();
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(
      loaded("etag-1", messages),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          Response.json({ id: "chunk-2", eTag: "etag-2" }, { status: 201 }),
        ),
    );

    const result = await appendTextMessage("2026-08", second);

    expect(result.state).toBe("loaded");
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toContain(
      "/messages/2026-08/0002.json:/content",
    );
  });

  it("fails explicitly after five consecutive conflicts", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(loaded("etag-1"));
    vi.mocked(readMonthSnapshot).mockResolvedValue(loaded("etag-new"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 412 })),
    );

    await expect(appendTextMessage("2026-08", second)).rejects.toThrow(
      "changed repeatedly",
    );
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("reports Graph throttling without silently queueing the send", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(loaded("etag-1"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "activityLimitReached",
              message: "The request has been throttled.",
            },
          },
          { status: 429, headers: { "Retry-After": "10" } },
        ),
      ),
    );

    await expect(appendTextMessage("2026-08", second)).rejects.toThrow(
      "The request has been throttled.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cached snapshot after an ambiguous network failure", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(loaded("etag-1"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(appendTextMessage("2026-08", second)).rejects.toThrow(
      "offline",
    );
    expect(deleteMonthCache).toHaveBeenCalledWith("2026-08");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
