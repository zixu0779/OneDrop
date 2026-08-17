import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@onedrop/platform/platform/onedrive-runtime", () => ({
  getOneDriveRuntime: () => ({
    getAccessToken: vi.fn().mockResolvedValue("access-token"),
  }),
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/month-archive", () => ({
  readRawMonthArchive: vi.fn(),
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/month-reader", () => ({
  readMonthSnapshot: vi.fn(),
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/tombstones", () => ({
  listMessageTombstonesWithAccessToken: vi.fn(),
  removeMessageTombstoneWithAccessToken: vi.fn(),
}));
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/sync-cache", () => ({
  deleteMonthCache: vi.fn(),
}));

import { deleteMonthCache } from "@onedrop/web-storage/infrastructure/indexed-db/sync-cache";
import { readRawMonthArchive } from "@onedrop/onedrive/infrastructure/onedrive/month-archive";
import { readMonthSnapshot } from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
import {
  readDeletedMessages,
  restoreDeletedMessage,
} from "@onedrop/onedrive/infrastructure/onedrive/recycle-bin";
import {
  listMessageTombstonesWithAccessToken,
  removeMessageTombstoneWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/tombstones";

const textId = "01989f5e-7700-7000-8000-000000000901";
const fileId = "01989f5e-7700-7000-8000-000000000902";
const imageId = "01989f5e-7700-7000-8000-000000000903";
const messages = [
  {
    schemaVersion: 1 as const,
    id: textId,
    type: "text" as const,
    text: "deleted text",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
  {
    schemaVersion: 1 as const,
    id: fileId,
    type: "file" as const,
    createdAt: "2026-07-01T10:00:00.000Z",
    attachment: {
      driveItemId: "file-drive-item",
      name: "notes.pdf",
      size: 100,
      mimeType: "application/pdf",
    },
  },
  {
    schemaVersion: 1 as const,
    id: imageId,
    type: "file" as const,
    createdAt: "2026-08-02T10:00:00.000Z",
    attachment: {
      driveItemId: "image-drive-item",
      name: "photo.heic",
      size: 200,
      mimeType: "image/heic",
    },
  },
];

describe("recycle bin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRawMonthArchive).mockResolvedValue({
      itemId: "archive-item",
      eTag: "archive-etag",
      document: {
        schemaVersion: 1,
        month: "2026-08",
        messages,
      },
    });
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "missing",
      month: "2026-08",
    });
    vi.mocked(listMessageTombstonesWithAccessToken).mockResolvedValue([
      {
        schemaVersion: 1,
        messageId: textId,
        originalMonth: "2026-08",
        deletedAt: "2026-08-11T10:00:00.000Z",
      },
      {
        schemaVersion: 1,
        messageId: fileId,
        originalMonth: "2026-08",
        deletedAt: "2026-08-10T10:00:00.000Z",
      },
      {
        schemaVersion: 1,
        messageId: imageId,
        originalMonth: "2026-08",
        deletedAt: "2026-08-12T10:00:00.000Z",
      },
    ]);
  });

  it("sorts by deletion time while retaining original messages and kinds", async () => {
    const items = await readDeletedMessages();

    expect(items.map((item) => item.message.id)).toEqual([
      imageId,
      textId,
      fileId,
    ]);
    expect(items.map((item) => item.kind)).toEqual(["image", "text", "file"]);
    expect(items[1]?.message.createdAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("restores only while both the tombstone and original record exist", async () => {
    const restored = await restoreDeletedMessage("2026-08", textId);

    expect(restored.message.id).toBe(textId);
    expect(removeMessageTombstoneWithAccessToken).toHaveBeenCalledWith(
      "2026-08",
      textId,
      "access-token",
    );
    expect(deleteMonthCache).toHaveBeenCalledWith("2026-08");
  });

  it("does not resurrect metadata that cleanup already removed", async () => {
    vi.mocked(readRawMonthArchive).mockResolvedValue(undefined);

    await expect(restoreDeletedMessage("2026-08", textId)).rejects.toThrow(
      "already been permanently deleted",
    );
    expect(removeMessageTombstoneWithAccessToken).not.toHaveBeenCalled();
  });
});
