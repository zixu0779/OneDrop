import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("../../src/infrastructure/onedrive/month-reader", () => ({
  readMonthSnapshot: vi.fn(),
}));

vi.mock("../../src/infrastructure/onedrive/month-archive", () => ({
  isMonthArchiveEligible: vi.fn().mockReturnValue(true),
  publishMonthArchive: vi.fn(),
  readMonthArchive: vi.fn(),
  readRawMonthArchive: vi.fn(),
}));

import { createTextMessage } from "../../src/features/messages/create-text-message";
import {
  checkArchiveTasks,
  resetArchiveTasks,
  retryArchiveTask,
} from "../../src/infrastructure/onedrive/archive-scheduler";
import {
  publishMonthArchive,
  readMonthArchive,
  readRawMonthArchive,
} from "../../src/infrastructure/onedrive/month-archive";
import { readMonthSnapshot } from "../../src/infrastructure/onedrive/month-reader";

const message = createTextMessage(
  "July history",
  new Date("2026-07-10T00:00:00.000Z"),
  "01989f5e-7700-7000-8000-000000000201",
);
const document = {
  schemaVersion: 1 as const,
  month: "2026-07",
  messages: [message],
};
const storage: Record<string, unknown> = {};
const sendMessage = vi.fn().mockResolvedValue(undefined);

function sourceMonthListing() {
  return Response.json({
    value: [{ id: "month-folder", name: "2026-07", folder: {} }],
  });
}

describe("archive scheduler", () => {
  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    vi.clearAllMocks();
    vi.stubGlobal("browser", {
      runtime: { sendMessage },
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
    vi.mocked(readMonthArchive).mockResolvedValue(undefined);
    vi.mocked(readMonthSnapshot).mockResolvedValue({
      state: "loaded",
      month: "2026-07",
      itemId: "chunk-item",
      eTag: "chunk-tag",
      document,
      chunks: [],
      corruptFiles: [],
      messageConflicts: [],
    });
    vi.mocked(publishMonthArchive).mockResolvedValue({
      itemId: "archive-item",
      eTag: "archive-tag",
      document,
    });
  });

  it("starts one eligible archive in the background and persists success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sourceMonthListing()));

    await expect(checkArchiveTasks()).resolves.toEqual([]);
    await vi.waitFor(() => expect(publishMonthArchive).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(JSON.stringify(storage)).toContain('"status":"succeeded"'),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("persists a retry delay and lets Retry bypass it", async () => {
    vi.mocked(publishMonthArchive)
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce({
        itemId: "archive-item",
        eTag: "archive-tag",
        document,
      });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sourceMonthListing()));

    await checkArchiveTasks();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "archives/event",
        notice: { month: "2026-07", phase: "failed" },
      }),
    );
    expect(JSON.stringify(storage)).toContain('"status":"cooling-down"');
    expect(JSON.stringify(storage)).toContain("nextRetryAt");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sourceMonthListing()));
    await checkArchiveTasks();
    await Promise.resolve();
    expect(publishMonthArchive).toHaveBeenCalledTimes(1);

    await expect(retryArchiveTask("2026-07")).resolves.toEqual({
      month: "2026-07",
      phase: "succeeded",
    });
    expect(publishMonthArchive).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "archives/event",
      notice: { month: "2026-07", phase: "running" },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "archives/event",
      notice: { month: "2026-07", phase: "succeeded" },
    });
  });

  it("re-verifies an archive before deleting source chunks on a later sync", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sourceMonthListing()));
    await checkArchiveTasks();
    await vi.waitFor(() =>
      expect(JSON.stringify(storage)).toContain('"cleanupPending":true'),
    );

    vi.mocked(readRawMonthArchive).mockResolvedValueOnce({
      itemId: "archive-item",
      eTag: "archive-tag",
      document,
    });
    vi.mocked(readMonthArchive).mockResolvedValueOnce({
      itemId: "archive-item",
      eTag: "archive-tag",
      document,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sourceMonthListing())
      .mockResolvedValueOnce(
        Response.json({ id: "month-folder", name: "2026-07", folder: {} }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await checkArchiveTasks();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/items/month-folder"),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(storage)).toContain('"cleanupPending":false'),
    );
  });

  it("prevents an old in-flight task from writing after test data reset", async () => {
    let finishPublication: (() => void) | undefined;
    vi.mocked(publishMonthArchive).mockReturnValueOnce(
      new Promise((resolve) => {
        finishPublication = () =>
          resolve({
            itemId: "archive-item",
            eTag: "archive-tag",
            document,
          });
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sourceMonthListing()));

    await checkArchiveTasks();
    await vi.waitFor(() => expect(publishMonthArchive).toHaveBeenCalledOnce());
    await resetArchiveTasks();
    finishPublication?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.stringify(storage)).not.toContain('"status":"succeeded"');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports a timeout but replaces it with success if the same task finishes", async () => {
    vi.useFakeTimers();
    try {
      let finishPublication: (() => void) | undefined;
      vi.mocked(publishMonthArchive).mockReturnValueOnce(
        new Promise((resolve) => {
          finishPublication = () =>
            resolve({
              itemId: "archive-item",
              eTag: "archive-tag",
              document,
            });
        }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(sourceMonthListing()),
      );

      await checkArchiveTasks();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(sendMessage).toHaveBeenCalledWith({
          type: "archives/event",
          notice: { month: "2026-07", phase: "failed" },
        }),
      );

      finishPublication?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(sendMessage).toHaveBeenCalledWith({
          type: "archives/event",
          notice: { month: "2026-07", phase: "succeeded" },
        }),
      );
      expect(JSON.stringify(storage)).toContain('"status":"succeeded"');
    } finally {
      vi.useRealTimers();
    }
  });
});
