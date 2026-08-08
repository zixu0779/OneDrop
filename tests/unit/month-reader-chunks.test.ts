import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/infrastructure/indexed-db/sync-cache", () => ({
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
  getMonthCache: vi.fn().mockResolvedValue(undefined),
  putMonthCache: vi.fn().mockResolvedValue(undefined),
}));

import { createTextMessage } from "../../src/features/messages/create-text-message";
import {
  deleteMonthCache,
  getMonthCache,
} from "../../src/infrastructure/indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readMonthSnapshot,
} from "../../src/infrastructure/onedrive/month-reader";

const firstMessage = createTextMessage(
  "first",
  new Date("2026-08-01T00:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000001",
);
const chunkMessage = createTextMessage(
  "chunk",
  new Date("2026-08-02T00:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000002",
);

function document(messages: (typeof firstMessage)[]) {
  return { schemaVersion: 1 as const, month: "2026-08", messages };
}

describe("chunked month reader", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges paginated chunks and deduplicates IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "chunk-1", name: "0001.json", eTag: "tag-1" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "chunk-2", name: "0002.json", eTag: "tag-2" }],
          }),
        )
        .mockResolvedValueOnce(Response.json(document([firstMessage])))
        .mockResolvedValueOnce(Response.json(document([chunkMessage]))),
    );

    const snapshot = await readMonthSnapshot("2026-08", "access-token");

    expect(snapshot.state).toBe("loaded");
    if (snapshot.state === "loaded") {
      expect(snapshot.chunks.map((chunk) => chunk.index)).toEqual([1, 2]);
      expect(snapshot.document.messages).toEqual([firstMessage, chunkMessage]);
      expect(snapshot.itemId).toBe("chunk-2");
    }
  });

  it("treats a missing chunk directory as an empty month", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })),
    );

    await expect(readMonthSnapshot("2026-08", "access-token")).resolves.toEqual(
      { state: "missing", month: "2026-08" },
    );
  });

  it("skips a damaged chunk for display while retaining healthy messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [
              { id: "chunk-1", name: "0001.json", eTag: "tag-1" },
              { id: "chunk-2", name: "0002.json", eTag: "tag-2" },
            ],
          }),
        )
        .mockResolvedValueOnce(Response.json(document([firstMessage])))
        .mockResolvedValueOnce(Response.json({ invalid: true })),
    );

    const snapshot = await readMonthSnapshot("2026-08", "access-token", true);

    expect(snapshot.state).toBe("loaded");
    if (snapshot.state === "loaded") {
      expect(snapshot.document.messages).toEqual([firstMessage]);
      expect(snapshot.corruptFiles).toEqual([
        { itemId: "chunk-2", name: "0002.json" },
      ]);
    }
  });

  it("blocks writes from using a snapshot with a damaged chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "chunk-1", name: "0001.json", eTag: "tag-1" }],
          }),
        )
        .mockResolvedValueOnce(Response.json({ invalid: true })),
    );

    await expect(readMonthSnapshot("2026-08", "access-token")).rejects.toThrow(
      "damaged monthly record file",
    );
  });

  it("reports both files and positions for conflicting message versions", async () => {
    const conflictingMessage = createTextMessage(
      "changed elsewhere",
      new Date(firstMessage.createdAt),
      firstMessage.id,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [
              { id: "chunk-1", name: "0001.json", eTag: "tag-1" },
              { id: "chunk-2", name: "0002.json", eTag: "tag-2" },
            ],
          }),
        )
        .mockResolvedValueOnce(Response.json(document([firstMessage])))
        .mockResolvedValueOnce(Response.json(document([conflictingMessage]))),
    );

    const snapshot = await readMonthSnapshot("2026-08", "access-token", true);

    expect(snapshot.state).toBe("loaded");
    if (snapshot.state === "loaded") {
      expect(snapshot.document.messages).toEqual([firstMessage]);
      expect(snapshot.messageConflicts).toEqual([
        {
          messageId: firstMessage.id,
          versions: [
            { itemId: "chunk-1", name: "0001.json", line: 1 },
            { itemId: "chunk-2", name: "0002.json", line: 1 },
          ],
        },
      ]);
    }
  });

  it("invalidates an old local snapshot that has no chunk metadata", async () => {
    vi.mocked(getMonthCache).mockResolvedValueOnce({
      month: "2026-08",
      itemId: "obsolete-month-file",
      eTag: "obsolete-tag",
      document: document([firstMessage]),
      cachedAt: new Date().toISOString(),
    });

    await expect(getCachedMonthSnapshot("2026-08")).resolves.toBeUndefined();
    expect(deleteMonthCache).toHaveBeenCalledWith("2026-08");
  });
});
