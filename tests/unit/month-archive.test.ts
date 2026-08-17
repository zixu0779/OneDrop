import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@onedrop/onedrive/infrastructure/onedrive/app-folder", () => ({
  verifyAppFolder: vi
    .fn()
    .mockResolvedValue({ id: "app-root", name: "OneDrop" }),
}));

vi.mock("@onedrop/onedrive/infrastructure/onedrive/tombstones", () => ({
  readTombstoneIds: vi.fn().mockResolvedValue(new Set()),
}));

import { createTextMessage } from "@onedrop/core/features/messages/create-text-message";
import {
  isMonthArchiveEligible,
  publishMonthArchive,
  readMonthArchive,
} from "@onedrop/onedrive/infrastructure/onedrive/month-archive";
import { readTombstoneIds } from "@onedrop/onedrive/infrastructure/onedrive/tombstones";

const firstMessage = createTextMessage(
  "archived",
  new Date("2026-06-01T00:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000101",
);
const deletedMessage = createTextMessage(
  "deleted",
  new Date("2026-06-02T00:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000102",
);
const document = {
  schemaVersion: 1 as const,
  month: "2026-06",
  messages: [firstMessage, deletedMessage],
};

describe("month archives", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits until the closed month has passed its 24-hour grace period", () => {
    expect(
      isMonthArchiveEligible("2026-06", new Date("2026-07-01T23:59:59Z")),
    ).toBe(false);
    expect(
      isMonthArchiveEligible("2026-06", new Date("2026-07-02T00:00:00Z")),
    ).toBe(true);
    expect(isMonthArchiveEligible("invalid", new Date())).toBe(false);
  });

  it("reads and validates an archive while applying later tombstones", async () => {
    vi.mocked(readTombstoneIds).mockResolvedValueOnce(
      new Set([deletedMessage.id]),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ id: "archive-item", eTag: "archive-tag" }),
        )
        .mockResolvedValueOnce(Response.json(document)),
    );

    await expect(readMonthArchive("2026-06", "token")).resolves.toEqual({
      itemId: "archive-item",
      eTag: "archive-tag",
      document: { ...document, messages: [firstMessage] },
    });
  });

  it("publishes with conflict-fail and verifies the uploaded content", async () => {
    const archivedDocument = { ...document, messages: [firstMessage] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "archive-folder" }))
      .mockResolvedValueOnce(
        Response.json(
          { id: "archive-item", eTag: "archive-tag" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "archive-item", eTag: "archive-tag" }),
      )
      .mockResolvedValueOnce(Response.json(archivedDocument));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishMonthArchive(archivedDocument, "token"),
    ).resolves.toMatchObject({
      itemId: "archive-item",
      eTag: "archive-tag",
      document: archivedDocument,
    });

    const publication = fetchMock.mock.calls[1]!;
    expect(publication[0]).toContain("archive/2026-06.json:/content");
    expect(publication[0]).toContain("conflictBehavior=fail");
    expect(publication[1]).toMatchObject({ method: "PUT" });
  });

  it("accepts a concurrently published identical archive", async () => {
    const archivedDocument = { ...document, messages: [firstMessage] };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: "archive-folder" }))
        .mockResolvedValueOnce(new Response(null, { status: 409 }))
        .mockResolvedValueOnce(
          Response.json({ id: "peer-archive", eTag: "peer-tag" }),
        )
        .mockResolvedValueOnce(Response.json(archivedDocument)),
    );

    await expect(
      publishMonthArchive(archivedDocument, "token"),
    ).resolves.toMatchObject({ itemId: "peer-archive", eTag: "peer-tag" });
  });

  it("rejects a published archive whose read-back content differs", async () => {
    const archivedDocument = { ...document, messages: [firstMessage] };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: "archive-folder" }))
        .mockResolvedValueOnce(
          Response.json(
            { id: "archive-item", eTag: "archive-tag" },
            { status: 201 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ id: "archive-item", eTag: "archive-tag" }),
        )
        .mockResolvedValueOnce(Response.json(document)),
    );

    await expect(
      publishMonthArchive(archivedDocument, "token"),
    ).rejects.toThrow("failed verification");
  });
});
