import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));
vi.mock("../../src/infrastructure/onedrive/app-folder", () => ({
  verifyAppFolder: vi
    .fn()
    .mockResolvedValue({ id: "app-root", name: "OneDrop" }),
}));

import {
  checkAttachmentExists,
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
});
