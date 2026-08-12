import { beforeEach, describe, expect, it, vi } from "vitest";

const throughput = vi.hoisted(() => ({
  getAverageUploadBytesPerSecond: vi.fn(),
  recordUploadThroughput: vi.fn(),
}));

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));
vi.mock("../../src/infrastructure/onedrive/app-folder", () => ({
  verifyAppFolder: vi
    .fn()
    .mockResolvedValue({ id: "app-root", name: "OneDrop" }),
}));
vi.mock(
  "../../src/infrastructure/indexed-db/upload-throughput",
  () => throughput,
);

import {
  checkAttachmentExists,
  getAttachmentDownloadUrl,
  getAttachmentWebUrl,
  uploadLargeFile,
  uploadSmallFile,
} from "../../src/infrastructure/onedrive/file-uploader";

describe("uploadSmallFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads to the deterministic message folder and returns attachment metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: "files", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "year", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "month", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "message", folder: {} }))
        .mockResolvedValueOnce(
          Response.json({ id: "uploaded", name: "hello.txt", size: 5 }),
        ),
    );

    const attachment = await uploadSmallFile({
      name: "hello.txt",
      mimeType: "text/plain",
      size: 5,
      base64: btoa("hello"),
      messageId: "01989f5e-7700-7000-8000-000000000001",
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    expect(attachment).toEqual({
      driveItemId: "uploaded",
      name: "hello.txt",
      size: 5,
      mimeType: "text/plain",
    });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain(
      "/items/message:/hello.txt:/content",
    );
  });

  it("reuses a matching DriveItem when Resend follows an ambiguous upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: "files", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "year", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "month", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "message", folder: {} }))
        .mockResolvedValueOnce(
          Response.json({ id: "already-uploaded", name: "photo", size: 5 }),
        ),
    );

    await expect(
      uploadSmallFile({
        name: "photo",
        mimeType: "image/png",
        size: 5,
        base64: btoa("hello"),
        messageId: "01989f5e-7700-7000-8000-000000000001",
        createdAt: "2026-08-03T00:00:00.000Z",
        reuseExisting: true,
        imageWidth: 640,
        imageHeight: 480,
        thumbHash: "AQIDBA==",
      }),
    ).resolves.toEqual({
      driveItemId: "already-uploaded",
      name: "photo",
      size: 5,
      mimeType: "image/png",
      imageWidth: 640,
      imageHeight: 480,
      thumbHash: "AQIDBA==",
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBeUndefined();
  });

  it("aborts a stalled upload operation after the application timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    try {
      const upload = uploadSmallFile({
        name: "hello.txt",
        mimeType: "text/plain",
        size: 5,
        base64: btoa("hello"),
        messageId: "01989f5e-7700-7000-8000-000000000001",
        createdAt: "2026-08-03T00:00:00.000Z",
      });
      const assertion = expect(upload).rejects.toThrow("upload timed out");
      await vi.advanceTimersByTimeAsync(12_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a DriveItem carrying the deleted facet as missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: "deleted-item",
          deleted: { state: "deleted" },
        }),
      ),
    );

    await expect(checkAttachmentExists("deleted-item")).resolves.toBe(false);
  });

  it("returns the temporary authenticated download URL for any file size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          "@microsoft.graph.downloadUrl":
            "https://download.example/large-file?token=temporary",
        }),
      ),
    );

    await expect(getAttachmentDownloadUrl("large-item")).resolves.toBe(
      "https://download.example/large-file?token=temporary",
    );
  });

  it("returns the OneDrive web URL for an attachment", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ webUrl: "https://onedrive.example/item/large-item" }),
        ),
    );

    await expect(getAttachmentWebUrl("large-item")).resolves.toBe(
      "https://onedrive.example/item/large-item",
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(
      "/items/large-item?$select=webUrl",
    );
  });
});

describe("uploadLargeFile", () => {
  beforeEach(() => {
    throughput.getAverageUploadBytesPerSecond.mockReset();
    throughput.recordUploadThroughput.mockReset();
  });

  it("creates an upload session and reports each confirmed 5 MiB fragment", async () => {
    throughput.getAverageUploadBytesPerSecond.mockResolvedValue(1024 * 1024);
    throughput.recordUploadThroughput.mockResolvedValue(2 * 1024 * 1024);
    const size = 6 * 1024 * 1024;
    const progress = vi.fn();
    const folderIds = ["files", "year", "month", "message"];
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const callIndex = fetchMock.mock.calls.length - 1;
        if (callIndex < 4) {
          return Response.json({ id: folderIds[callIndex]!, folder: {} });
        }
        if (callIndex === 4) {
          return Response.json({ uploadUrl: "https://upload.example/session" });
        }
        const range = (init?.headers as Record<string, string>)[
          "Content-Range"
        ];
        const end = Number(/bytes \d+-(\d+)\//u.exec(range!)?.[1]);
        return end === size - 1
          ? Response.json(
              { id: "large-item", name: "large.bin", size },
              { status: 201 },
            )
          : Response.json(
              { nextExpectedRanges: [`${end + 1}-`] },
              { status: 202 },
            );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadLargeFile({
        name: "large.bin",
        mimeType: "application/octet-stream",
        size,
        blob: new Blob([new Uint8Array(size)]),
        messageId: "01989f5e-7700-7000-8000-000000000001",
        createdAt: "2026-08-03T00:00:00.000Z",
        signal: new AbortController().signal,
        onProgress: progress,
      }),
    ).resolves.toEqual({
      driveItemId: "large-item",
      name: "large.bin",
      size,
      mimeType: "application/octet-stream",
    });

    const requests = vi.mocked(fetch).mock.calls;
    expect(requests[5]?.[1]?.headers).toMatchObject({
      "Content-Range": `bytes 0-${5 * 1024 * 1024 - 1}/${size}`,
    });
    expect(requests[6]?.[1]?.headers).toMatchObject({
      "Content-Range": `bytes ${5 * 1024 * 1024}-${size - 1}/${size}`,
    });
    expect(progress).toHaveBeenCalledWith(
      5 * 1024 * 1024,
      size,
      size,
      2 * 1024 * 1024,
    );
    expect(progress).toHaveBeenLastCalledWith(
      size,
      size,
      size,
      2 * 1024 * 1024,
    );
    expect(throughput.recordUploadThroughput).toHaveBeenCalledTimes(2);
  });

  it("does not fail an upload when local throughput statistics fail", async () => {
    const size = 5 * 1024 * 1024;
    throughput.getAverageUploadBytesPerSecond.mockRejectedValue(
      new Error("IndexedDB unavailable"),
    );
    throughput.recordUploadThroughput.mockRejectedValue(
      new Error("IndexedDB unavailable"),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ id: "files", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "year", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "month", folder: {} }))
        .mockResolvedValueOnce(Response.json({ id: "message", folder: {} }))
        .mockResolvedValueOnce(
          Response.json({ uploadUrl: "https://upload.example/session" }),
        )
        .mockResolvedValueOnce(
          Response.json(
            { id: "large-item", name: "large.bin", size },
            { status: 201 },
          ),
        ),
    );

    await expect(
      uploadLargeFile({
        name: "large.bin",
        mimeType: "application/octet-stream",
        size,
        blob: new Blob([new Uint8Array(size)]),
        messageId: "01989f5e-7700-7000-8000-000000000001",
        createdAt: "2026-08-03T00:00:00.000Z",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ driveItemId: "large-item" });
  });
});
