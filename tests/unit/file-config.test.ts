import { describe, expect, it } from "vitest";

import {
  getUploadChunkBytes,
  shouldUseUploadSession,
} from "@onedrop/core/config/files";

describe("file upload thresholds", () => {
  it("keeps files below 320 KiB on direct upload", () => {
    expect(
      shouldUseUploadSession({
        size: 320 * 1024 - 1,
        mimeType: "application/pdf",
      }),
    ).toBe(false);
  });

  it("uses 320 KiB fragments below 1 MiB", () => {
    const input = { size: 320 * 1024, mimeType: "application/pdf" };
    expect(shouldUseUploadSession(input)).toBe(true);
    expect(getUploadChunkBytes(input)).toBe(320 * 1024);
  });

  it("uses 640 KiB fragments for medium files and images", () => {
    expect(
      getUploadChunkBytes({ size: 1024 * 1024, mimeType: "application/pdf" }),
    ).toBe(640 * 1024);
    expect(
      getUploadChunkBytes({ size: 8 * 1024 * 1024, mimeType: "image/jpeg" }),
    ).toBe(640 * 1024);
  });

  it("retains 5 MiB fragments for ordinary large files", () => {
    expect(
      getUploadChunkBytes({
        size: 8 * 1024 * 1024,
        mimeType: "application/zip",
      }),
    ).toBe(5 * 1024 * 1024);
  });
});
