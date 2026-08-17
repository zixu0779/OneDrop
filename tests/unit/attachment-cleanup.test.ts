import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@onedrop/app-runtime/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/month-archive", () => ({
  readRawMonthArchive: vi.fn(),
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/month-reader", () => ({
  readMonthSnapshot: vi.fn(),
}));
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/sync-cache", () => ({
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
}));

import {
  cleanDeletedDataNow,
  checkAttachmentCleanup,
  resetAttachmentCleanup,
} from "@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup";
import { readRawMonthArchive } from "@onedrop/onedrive/infrastructure/onedrive/month-archive";
import { readMonthSnapshot } from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import type { Message } from "@onedrop/core/domain/message";

const messageId = "01989f5e-7700-7000-8000-000000000001";
const driveItemId = "attachment-item";
const storage: Record<string, unknown> = {};
const fileMessage = {
  schemaVersion: 1 as const,
  id: messageId,
  type: "file" as const,
  createdAt: "2026-08-01T12:00:00.000Z",
  attachment: {
    driveItemId,
    name: "document.pdf",
    size: 1024,
    mimeType: "application/pdf",
  },
};
const textMessage = {
  schemaVersion: 1 as const,
  id: messageId,
  type: "text" as const,
  createdAt: "2026-08-01T12:00:00.000Z",
  text: "deleted text",
};
const uploadingMessage = {
  schemaVersion: 1 as const,
  id: messageId,
  type: "file-uploading" as const,
  createdAt: "2026-08-01T12:00:00.000Z",
  pendingAttachment: {
    name: "unfinished.bin",
    size: 1024,
    mimeType: "application/octet-stream",
  },
};

function tombstoneListing(deletedAt: string) {
  return [
    Response.json({
      value: [{ id: "tombstone-item", name: "2026-08.json" }],
    }),
    Response.json({
      schemaVersion: 1,
      month: "2026-08",
      tombstones: [
        {
          schemaVersion: 1,
          messageId,
          originalMonth: "2026-08",
          deletedAt,
        },
      ],
    }),
  ];
}

function validArchive(messages: Message[] = [fileMessage]) {
  vi.mocked(readRawMonthArchive).mockResolvedValue({
    itemId: "archive-item",
    eTag: "archive-tag",
    document: { schemaVersion: 1, month: "2026-08", messages },
  });
}

function metadataCleanupResponses() {
  return [
    new Response("{}", { status: 200 }),
    Response.json({ id: "tombstone-item", eTag: "tombstone-tag" }),
    tombstoneListing("2026-08-01T00:00:00.000Z")[1],
    new Response("{}", { status: 200 }),
  ];
}

describe("attachment cleanup", () => {
  beforeEach(async () => {
    for (const key of Object.keys(storage)) delete storage[key];
    vi.clearAllMocks();
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "missing",
      month: "2026-08",
    });
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (value: Record<string, unknown>) =>
            Object.assign(storage, value),
          ),
          remove: vi.fn(async (key: string) => delete storage[key]),
        },
      },
    });
    await resetAttachmentCleanup();
  });

  it("deletes a verified attachment folder after the ten-day grace period", async () => {
    validArchive();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tombstoneListing("2026-08-01T00:00:00.000Z")[0])
      .mockResolvedValueOnce(tombstoneListing("2026-08-01T00:00:00.000Z")[1])
      .mockResolvedValueOnce(
        Response.json({ id: "message-folder", folder: {} }),
      )
      .mockResolvedValueOnce(Response.json({ value: [{ id: driveItemId }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/items/message-folder"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(JSON.stringify(storage)).toContain(`2026-08:${messageId}`);
  });

  it("cleans an eligible current-month attachment from raw chunk data", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "loaded",
      month: "2026-08",
      itemId: "chunk-item",
      eTag: "chunk-tag",
      document: { schemaVersion: 1, month: "2026-08", messages: [] },
      chunks: [
        {
          index: 1,
          itemId: "chunk-item",
          eTag: "chunk-tag",
          document: {
            schemaVersion: 1,
            month: "2026-08",
            messages: [fileMessage],
          },
        },
      ],
    });
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(
        Response.json({ id: "message-folder", folder: {} }),
      )
      .mockResolvedValueOnce(Response.json({ value: [{ id: driveItemId }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toBe(1);
    expect(readMonthSnapshot).toHaveBeenCalledWith(
      "2026-08",
      "access-token",
      true,
    );
  });

  it("does not inspect or delete an attachment before ten days", async () => {
    const responses = tombstoneListing("2026-08-02T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T23:59:59.000Z")),
    ).resolves.toBe(0);

    expect(readRawMonthArchive).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("manual cleanup bypasses the grace period and returns an explicit summary", async () => {
    validArchive([textMessage]);
    const responses = tombstoneListing("2026-08-10T23:59:59.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-11T00:00:00.000Z")),
    ).resolves.toEqual({ messages: 1, attachments: 0 });
  });

  it("physically removes archived text metadata before its tombstone", async () => {
    validArchive([textMessage]);
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toBe(0);

    const putCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCalls).toHaveLength(2);
    expect(String((putCalls[0]![1] as RequestInit).body)).not.toContain(
      messageId,
    );
    expect(String((putCalls[1]![1] as RequestInit).body)).not.toContain(
      messageId,
    );
  });

  it("removes a file-uploading placeholder without looking for an attachment", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "loaded",
      month: "2026-08",
      itemId: "chunk-item",
      eTag: "chunk-tag",
      document: { schemaVersion: 1, month: "2026-08", messages: [] },
      chunks: [
        {
          index: 1,
          itemId: "chunk-item",
          eTag: "chunk-tag",
          document: {
            schemaVersion: 1,
            month: "2026-08",
            messages: [uploadingMessage],
          },
        },
      ],
    });
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z"));

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/files/")),
    ).toBe(false);
  });

  it("keeps the tombstone when message metadata cannot be rewritten", async () => {
    validArchive([textMessage]);
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).rejects.toThrow("Deleted message cleanup failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(storage)).not.toContain("lastScanAt");
  });

  it("cleans healthy metadata without failing when another chunk is damaged", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "loaded",
      month: "2026-08",
      itemId: "chunk-item",
      eTag: "chunk-tag",
      document: { schemaVersion: 1, month: "2026-08", messages: [] },
      chunks: [
        {
          index: 1,
          itemId: "chunk-item",
          eTag: "chunk-tag",
          document: {
            schemaVersion: 1,
            month: "2026-08",
            messages: [textMessage],
          },
        },
      ],
      corruptFiles: [{ itemId: "damaged-item", name: "0099.json" }],
    });
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("[BROKEN]", { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-item", eTag: "tombstone-tag" }),
      )
      .mockResolvedValueOnce(tombstoneListing("2026-08-01T00:00:00.000Z")[1])
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-11T00:00:00.000Z")),
    ).resolves.toEqual({ messages: 1, attachments: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(String(fetchMock.mock.calls[2]![1]?.body)).not.toContain(messageId);
  });

  it("retains the tombstone when only a damaged source file could contain the message", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "missing",
      month: "2026-08",
      corruptFiles: [{ itemId: "damaged-item", name: "0099.json" }],
    });
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(new Response("[BROKEN]", { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-item", eTag: "tombstone-tag" }),
      )
      .mockResolvedValueOnce(tombstoneListing("2026-08-01T00:00:00.000Z")[1])
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-11T00:00:00.000Z")),
    ).resolves.toEqual({ messages: 1, attachments: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("retains the tombstone when damaged source bytes contain the message id", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "missing",
      month: "2026-08",
      corruptFiles: [{ itemId: "damaged-item", name: "0099.json" }],
    });
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(
        new Response(`corrupt bytes ${messageId}`, { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-11T00:00:00.000Z")),
    ).resolves.toEqual({ messages: 0, attachments: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses cleanup when the original message has conflicting versions", async () => {
    validArchive([
      fileMessage,
      {
        schemaVersion: 1,
        id: messageId,
        type: "text",
        createdAt: "2026-08-01T12:00:00.000Z",
        text: "conflicting record",
      },
    ]);
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(storage)).not.toContain(`2026-08:${messageId}`);
  });

  it("defers a target-message conflict without failing manual cleanup", async () => {
    validArchive([
      fileMessage,
      {
        schemaVersion: 1,
        id: messageId,
        type: "text",
        createdAt: "2026-08-01T12:00:00.000Z",
        text: "conflicting record",
      },
    ]);
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toEqual({ messages: 0, attachments: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(storage)).not.toContain(`2026-08:${messageId}`);
  });

  it("refuses cleanup while another visible message references the attachment", async () => {
    validArchive([
      fileMessage,
      {
        ...fileMessage,
        id: "01989f5e-7700-7000-8000-000000000002",
      },
    ]);
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(storage)).not.toContain(`2026-08:${messageId}`);
  });

  it("treats a missing file inside an existing message folder as already absent", async () => {
    validArchive();
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1])
      .mockResolvedValueOnce(
        Response.json({ id: "message-folder", folder: {} }),
      )
      .mockResolvedValueOnce(Response.json({ value: [] }));
    for (const response of metadataCleanupResponses()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cleanDeletedDataNow(new Date("2026-08-01T00:00:01.000Z")),
    ).resolves.toEqual({ messages: 1, attachments: 0 });

    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/items/message-folder") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("keeps cleanup retryable when the OneDrive delete fails", async () => {
    validArchive();
    const firstResponses = tombstoneListing("2026-08-01T00:00:00.000Z");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(firstResponses[0])
        .mockResolvedValueOnce(firstResponses[1])
        .mockResolvedValueOnce(
          Response.json({ id: "message-folder", folder: {} }),
        )
        .mockResolvedValueOnce(Response.json({ value: [{ id: driveItemId }] }))
        .mockResolvedValueOnce(new Response("temporary", { status: 503 })),
    );

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:01.000Z")),
    ).rejects.toThrow("Attachment cleanup failed");
    expect(JSON.stringify(storage)).not.toContain("lastScanAt");

    const retryResponses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(retryResponses[0])
      .mockResolvedValueOnce(retryResponses[1])
      .mockResolvedValueOnce(
        Response.json({ id: "message-folder", folder: {} }),
      )
      .mockResolvedValueOnce(Response.json({ value: [{ id: driveItemId }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    for (const response of metadataCleanupResponses()) {
      retryFetch.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", retryFetch);

    await expect(
      checkAttachmentCleanup(new Date("2026-08-11T00:00:02.000Z")),
    ).resolves.toBe(1);
  });

  it("skips another remote scan for twenty-four hours after success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await checkAttachmentCleanup(new Date("2026-08-11T00:00:00.000Z"));
    await checkAttachmentCleanup(new Date("2026-08-11T12:00:00.000Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates an in-flight cleanup when local account state is reset", async () => {
    let finishArchiveRead: (() => void) | undefined;
    vi.mocked(readRawMonthArchive).mockReturnValue(
      new Promise((resolve) => {
        finishArchiveRead = () =>
          resolve({
            itemId: "archive-item",
            eTag: "archive-tag",
            document: {
              schemaVersion: 1,
              month: "2026-08",
              messages: [fileMessage],
            },
          });
      }),
    );
    const responses = tombstoneListing("2026-08-01T00:00:00.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    const cleanup = checkAttachmentCleanup(
      new Date("2026-08-11T00:00:01.000Z"),
    );
    await vi.waitFor(() => expect(readRawMonthArchive).toHaveBeenCalledOnce());
    await resetAttachmentCleanup();
    finishArchiveRead?.();

    await expect(cleanup).rejects.toThrow("Attachment cleanup was reset");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
