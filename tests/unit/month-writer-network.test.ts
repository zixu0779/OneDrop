import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@onedrop/app-runtime/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("@onedrop/web-storage/infrastructure/indexed-db/sync-cache", () => ({
  deleteMessagesFolderId: vi.fn().mockResolvedValue(undefined),
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
  getMessagesFolderId: vi.fn().mockResolvedValue("messages-folder-id"),
  putMessagesFolderId: vi.fn().mockResolvedValue(undefined),
  putMonthCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@onedrop/onedrive/infrastructure/onedrive/month-reader", () => ({
  getCachedMonthSnapshot: vi.fn(),
  readMonthDocument: vi.fn(),
  readMonthSnapshot: vi.fn(),
}));

import { createTextMessage } from "@onedrop/core/features/messages/create-text-message";
import type { Message } from "@onedrop/core/domain/message";
import {
  createFileMessage,
  createUploadingFileMessage,
} from "@onedrop/core/features/messages/create-file-message";
import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import {
  getCachedMonthSnapshot,
  readMonthDocument,
  readMonthSnapshot,
} from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import {
  appendTextMessage,
  removeMessage,
  resolveMessageConflict,
  replaceMessage,
} from "@onedrop/onedrive/infrastructure/onedrive/month-writer";

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

function loaded(eTag: string, messages: Message[] = [first]) {
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

  it("writes around a damaged fixture without reusing its chunk number", async () => {
    const messages = largeMessages();
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      ...loaded("etag-2", messages),
      corruptFiles: [{ itemId: "damaged-3", name: "0003.json" }],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          Response.json({ id: "chunk-4", eTag: "etag-4" }, { status: 201 }),
        ),
    );

    await expect(appendTextMessage("2026-08", second)).resolves.toMatchObject({
      state: "loaded",
    });
    expect(readMonthSnapshot).toHaveBeenCalledWith(
      "2026-08",
      "access-token",
      true,
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toContain(
      "/messages/2026-08/0004.json:/content",
    );
  });

  it("writes around a conflict that belongs to another message", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      ...loaded("etag-2"),
      messageConflicts: [
        {
          messageId: first.id,
          versions: [
            { itemId: "chunk-1", name: "0001.json", line: 5 },
            { itemId: "chunk-2", name: "0002.json", line: 5 },
          ],
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "chunk-1", eTag: "etag-3" }, { status: 200 }),
        ),
    );

    await expect(appendTextMessage("2026-08", second)).resolves.toMatchObject({
      state: "loaded",
    });
  });

  it("still blocks writes targeting the conflicted message itself", async () => {
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      ...loaded("etag-2"),
      messageConflicts: [
        {
          messageId: second.id,
          versions: [
            { itemId: "chunk-1", name: "0001.json", line: 5 },
            { itemId: "chunk-2", name: "0002.json", line: 5 },
          ],
        },
      ],
    });

    await expect(appendTextMessage("2026-08", second)).rejects.toThrow(
      "conflicting versions",
    );
    expect(fetch).not.toHaveBeenCalled();
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

  it("replaces an uploading placeholder in its original chunk", async () => {
    const id = "01989f5e-7700-7000-8000-000000000031";
    const sender = "01989f5e-7700-7000-8000-000000000099";
    const createdAt = new Date("2026-08-03T00:00:00.000Z");
    const placeholder = createUploadingFileMessage(
      { name: "photo.png", size: 5, mimeType: "image/png" },
      sender,
      createdAt,
      id,
    );
    const ready = createFileMessage(
      {
        driveItemId: "drive-item",
        name: "photo.png",
        size: 5,
        mimeType: "image/png",
      },
      sender,
      createdAt,
      id,
    );
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(
      loaded("etag-1", [placeholder]),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { id: "month-item-id", eTag: "etag-2" },
            { status: 200 },
          ),
        ),
    );

    const result = await replaceMessage("2026-08", ready);

    expect(result.state).toBe("loaded");
    if (result.state === "loaded") {
      expect(result.messages).toEqual([ready]);
    }
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([ready]);
  });

  it("removes an abandoned uploading placeholder", async () => {
    const placeholder = createUploadingFileMessage(
      { name: "abandoned.pdf", size: 42, mimeType: "application/pdf" },
      "01989f5e-7700-7000-8000-000000000099",
      new Date("2026-08-03T00:00:00.000Z"),
      "01989f5e-7700-7000-8000-000000000041",
    );
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(
      loaded("etag-1", [first, placeholder]),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { id: "month-item-id", eTag: "etag-2" },
            { status: 200 },
          ),
        ),
    );

    await removeMessage("2026-08", placeholder.id);

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([first]);
  });

  it("never removes an already finalized file message", async () => {
    const ready = createFileMessage(
      {
        driveItemId: "drive-item",
        name: "ready.pdf",
        size: 42,
        mimeType: "application/pdf",
      },
      "01989f5e-7700-7000-8000-000000000099",
      new Date("2026-08-03T00:00:00.000Z"),
      "01989f5e-7700-7000-8000-000000000042",
    );
    vi.mocked(getCachedMonthSnapshot).mockResolvedValue(
      loaded("etag-1", [ready]),
    );
    vi.stubGlobal("fetch", vi.fn());

    await removeMessage("2026-08", ready.id);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the selected version and removes only the conflicting duplicate", async () => {
    const conflicting = createTextMessage(
      "conflicting",
      new Date(first.createdAt),
      first.id,
    );
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "loaded",
      month: "2026-08",
      itemId: "chunk-2",
      eTag: "etag-2",
      document: {
        schemaVersion: 1,
        month: "2026-08",
        messages: [first],
      },
      chunks: [
        {
          index: 1,
          itemId: "chunk-1",
          eTag: "etag-1",
          document: {
            schemaVersion: 1,
            month: "2026-08",
            messages: [first],
          },
        },
        {
          index: 2,
          itemId: "chunk-2",
          eTag: "etag-2",
          document: {
            schemaVersion: 1,
            month: "2026-08",
            messages: [conflicting, second],
          },
        },
      ],
      messageConflicts: [
        {
          messageId: first.id,
          versions: [
            { itemId: "chunk-1", name: "0001.json", line: 1 },
            { itemId: "chunk-2", name: "0002.json", line: 1 },
          ],
        },
      ],
    });
    vi.mocked(readMonthDocument).mockResolvedValue({
      state: "loaded",
      month: "2026-08",
      eTag: "etag-3",
      messages: [first, second],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "chunk-2", eTag: "etag-3" }, { status: 200 }),
        ),
    );

    const result = await resolveMessageConflict("2026-08", first.id, "chunk-1");

    expect(result.state).toBe("loaded");
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([second]);
  });
});
