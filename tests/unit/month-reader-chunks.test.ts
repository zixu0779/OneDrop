import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/infrastructure/indexed-db/sync-cache", () => ({
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
  getMonthCache: vi.fn().mockResolvedValue(undefined),
  putMonthCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/infrastructure/onedrive/tombstones", () => ({
  readTombstoneIds: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("../../src/infrastructure/onedrive/month-archive", () => ({
  isMonthArchiveEligible: vi.fn().mockReturnValue(true),
  publishMonthArchive: vi.fn(),
  readMonthArchive: vi.fn(),
}));

import { createTextMessage } from "../../src/features/messages/create-text-message";
import {
  deleteMonthCache,
  getMonthCache,
} from "../../src/infrastructure/indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readHistoricalMonthDocument,
  readMonthSnapshot,
} from "../../src/infrastructure/onedrive/month-reader";
import {
  publishMonthArchive,
  readMonthArchive,
} from "../../src/infrastructure/onedrive/month-archive";
import { readTombstoneIds } from "../../src/infrastructure/onedrive/tombstones";

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

  it("uses a validated archive without enumerating source chunks", async () => {
    vi.mocked(readMonthArchive).mockResolvedValueOnce({
      itemId: "archive-item",
      eTag: "archive-tag",
      document: document([firstMessage]),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readHistoricalMonthDocument("2026-08")).resolves.toEqual({
      state: "loaded",
      month: "2026-08",
      eTag: "archive-tag",
      messages: [firstMessage],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back when an archive lookup does not settle", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(readMonthArchive).mockReturnValueOnce(new Promise(() => {}));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })),
      );

      const result = readHistoricalMonthDocument("2026-08");
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(result).resolves.toEqual({
        state: "missing",
        month: "2026-08",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns healthy chunks without publishing an archive", async () => {
    vi.mocked(readMonthArchive).mockResolvedValueOnce(undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "chunk-1", name: "0001.json", eTag: "tag-1" }],
          }),
        )
        .mockResolvedValueOnce(Response.json(document([firstMessage]))),
    );

    await expect(readHistoricalMonthDocument("2026-08")).resolves.toEqual({
      state: "loaded",
      month: "2026-08",
      eTag: "tag-1",
      messages: [firstMessage],
    });
    expect(publishMonthArchive).not.toHaveBeenCalled();
  });

  it("does not publish an archive from an incomplete damaged snapshot", async () => {
    vi.mocked(readMonthArchive).mockResolvedValueOnce(undefined);
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

    await expect(readHistoricalMonthDocument("2026-08")).resolves.toEqual({
      state: "loaded",
      month: "2026-08",
      eTag: "tag-1",
      messages: [firstMessage],
      corruptFiles: [{ itemId: "chunk-2", name: "0002.json" }],
    });
    expect(publishMonthArchive).not.toHaveBeenCalled();
  });

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

  it("downloads no more than three changed chunks concurrently", async () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      createTextMessage(
        `chunk-${index + 1}`,
        new Date(`2026-08-0${index + 1}T00:00:00.000Z`),
        `01989f5e-7700-7000-8000-00000000010${index + 1}`,
      ),
    );
    let activeDownloads = 0;
    let peakDownloads = 0;
    const releases: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        if (String(input).includes("/children?")) {
          return Promise.resolve(
            Response.json({
              value: messages.map((_, index) => ({
                id: `chunk-${index + 1}`,
                name: `${String(index + 1).padStart(4, "0")}.json`,
                eTag: `tag-${index + 1}`,
              })),
            }),
          );
        }
        const chunkIndex = Number(String(input).match(/chunk-(\d+)/u)?.[1]);
        activeDownloads += 1;
        peakDownloads = Math.max(peakDownloads, activeDownloads);
        return new Promise<Response>((resolve) => {
          releases.push(() => {
            activeDownloads -= 1;
            resolve(Response.json(document([messages[chunkIndex - 1]!])));
          });
        });
      }),
    );

    const snapshotPromise = readMonthSnapshot("2026-08", "access-token");
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0, 3).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    await snapshotPromise;

    expect(peakDownloads).toBe(3);
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

  it("filters messages recorded by a monthly tombstone", async () => {
    vi.mocked(readTombstoneIds).mockResolvedValueOnce(
      new Set([firstMessage.id]),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "chunk-1", name: "0001.json", eTag: "tag-1" }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json(document([firstMessage, chunkMessage])),
        ),
    );

    const snapshot = await readMonthSnapshot("2026-08", "access-token");

    expect(snapshot.state).toBe("loaded");
    if (snapshot.state === "loaded") {
      expect(snapshot.document.messages).toEqual([chunkMessage]);
    }
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
