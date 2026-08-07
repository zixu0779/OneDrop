import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn().mockResolvedValue("access-token"),
}));
vi.mock("../../src/infrastructure/onedrive/app-folder", () => ({
  verifyAppFolder: vi
    .fn()
    .mockResolvedValue({ id: "app-root", name: "OneDrop" }),
}));

import { uploadSmallFile } from "../../src/infrastructure/onedrive/file-uploader";

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
});
