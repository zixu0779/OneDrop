import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@onedrop/app-runtime/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("@onedrop/web-storage/infrastructure/indexed-db/sync-cache", () => ({
  deleteMonthCache: vi.fn().mockResolvedValue(undefined),
}));

import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import {
  removeMessageTombstoneWithAccessToken,
  writeMessageTombstone,
} from "@onedrop/onedrive/infrastructure/onedrive/tombstones";

const messageId = "01989f5e-7700-7000-8000-000000000001";

describe("message tombstones", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a monthly tombstone document before refreshing messages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "tombstones-folder" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-file", eTag: "tombstone-tag" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await writeMessageTombstone("2026-08", messageId);

    const createRequest = fetchMock.mock.calls[2]!;
    expect(createRequest[0]).toContain("tombstones/2026-08.json:/content");
    expect(JSON.parse(String(createRequest[1]?.body))).toMatchObject({
      schemaVersion: 1,
      month: "2026-08",
      tombstones: [{ messageId, originalMonth: "2026-08" }],
    });
    expect(deleteMonthCache).toHaveBeenCalledWith("2026-08");
  });

  it("creates the tombstones folder through the app root item id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ id: "app-root-id", name: "OneDrop" }),
      )
      .mockResolvedValueOnce(Response.json({ id: "tombstones-folder" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-file", eTag: "tombstone-tag" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await writeMessageTombstone("2026-08", messageId);

    expect(fetchMock.mock.calls[2]![0]).toContain(
      "/me/drive/items/app-root-id/children",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toMatchObject(
      {
        name: "tombstones",
        folder: {},
      },
    );
  });

  it("re-reads and merges after a concurrent first-document create", async () => {
    const otherMessageId = "01989f5e-7700-7000-8000-000000000002";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "tombstones-folder" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-file", eTag: "etag-from-peer" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: 1,
          month: "2026-08",
          tombstones: [
            {
              schemaVersion: 1,
              messageId: otherMessageId,
              originalMonth: "2026-08",
              deletedAt: "2026-08-09T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-file", eTag: "merged-etag" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await writeMessageTombstone("2026-08", messageId);

    const updateRequest = fetchMock.mock.calls[5]!;
    expect(updateRequest[1]?.headers).toMatchObject({
      "If-Match": "etag-from-peer",
    });
    expect(
      JSON.parse(String(updateRequest[1]?.body)).tombstones.map(
        (item: { messageId: string }) => item.messageId,
      ),
    ).toEqual([otherMessageId, messageId]);
  });

  it("restores a message by removing its tombstone with an ETag guard", async () => {
    const otherMessageId = "01989f5e-7700-7000-8000-000000000002";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "tombstone-file", eTag: "restore-etag" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: 1,
          month: "2026-08",
          tombstones: [
            {
              schemaVersion: 1,
              messageId,
              originalMonth: "2026-08",
              deletedAt: "2026-08-09T00:00:00.000Z",
            },
            {
              schemaVersion: 1,
              messageId: otherMessageId,
              originalMonth: "2026-08",
              deletedAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "tombstone-file" }));
    vi.stubGlobal("fetch", fetchMock);

    await removeMessageTombstoneWithAccessToken(
      "2026-08",
      messageId,
      "access-token",
    );

    const update = fetchMock.mock.calls[2]!;
    expect(update[1]?.headers).toMatchObject({ "If-Match": "restore-etag" });
    expect(
      JSON.parse(String(update[1]?.body)).tombstones.map(
        (item: { messageId: string }) => item.messageId,
      ),
    ).toEqual([otherMessageId]);
    expect(deleteMonthCache).toHaveBeenCalledWith("2026-08");
  });
});
