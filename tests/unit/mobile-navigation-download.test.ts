import { configureAccountContext } from "@onedrop/app-runtime/features/auth/account-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAttachmentDownloadUrl = vi.hoisted(() => vi.fn());
vi.mock("@onedrop/onedrive/infrastructure/onedrive/file-uploader", () => ({
  getAttachmentDownloadUrl,
}));

import {
  removeMobileAccountTasks,
  cancelMobileNavigationDownload,
  claimMobileNavigationDownload,
  prepareMobileNavigationDownload,
  readMobileNavigationDownloadStatus,
} from "@onedrop/app-runtime/features/downloads/mobile-navigation-download";

const attachment = {
  driveItemId: "drive-item",
  name: "extension.crx",
  mimeType: "application/x-chrome-extension",
  size: 1_000,
};

describe("mobile navigation download", () => {
  const storage = new Map<string, unknown>();
  const searchDownloads = vi.fn();
  const cancel = vi.fn(async () => undefined);
  const removeFile = vi.fn(async () => undefined);
  const erase = vi.fn(async () => []);

  beforeEach(() => {
    vi.clearAllMocks();
    configureAccountContext("signed-out");
    storage.clear();
    getAttachmentDownloadUrl.mockResolvedValue("https://files.test/download");
    searchDownloads.mockResolvedValue([]);
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async (key: string | null) =>
            key === null
              ? Object.fromEntries(storage)
              : { [key]: storage.get(key) },
          ),
          set: vi.fn(async (values: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(values))
              storage.set(key, value);
          }),
          remove: vi.fn(async (key: string | string[]) => {
            for (const item of Array.isArray(key) ? key : [key])
              storage.delete(item);
          }),
        },
      },
      downloads: { search: searchDownloads, cancel, removeFile, erase },
    });
  });

  it("prepares an HTTP navigation without creating a browser download", async () => {
    const result = await prepareMobileNavigationDownload(attachment);

    expect(result).toMatchObject({
      state: "waiting",
      filename: "extension.crx",
      sourceUrl: "https://files.test/download",
      bytesReceived: 0,
    });
  });

  it("claims the download item created by current-page HTTP navigation", async () => {
    await prepareMobileNavigationDownload(attachment);
    await claimMobileNavigationDownload({
      id: 17,
      url: "https://files.test/download",
      finalUrl: "https://cdn.test/file",
      filename: "/storage/emulated/0/Download/extension.crx",
      state: "in_progress",
      bytesReceived: 250,
      totalBytes: 1_000,
    } as Browser.downloads.DownloadItem);
    searchDownloads.mockResolvedValue([
      {
        id: 17,
        state: "in_progress",
        filename: "/storage/emulated/0/Download/extension.crx",
        bytesReceived: 250,
        totalBytes: 1_000,
      },
    ]);

    await expect(
      readMobileNavigationDownloadStatus("drive-item"),
    ).resolves.toMatchObject({
      state: "downloading",
      downloadId: 17,
      bytesReceived: 250,
    });
  });

  it("reports completion from the matched Edge download record", async () => {
    await prepareMobileNavigationDownload(attachment);
    await claimMobileNavigationDownload({
      id: 17,
      url: "https://files.test/download",
      filename: "extension.crx",
      state: "in_progress",
      bytesReceived: 100,
      totalBytes: 1_000,
    } as Browser.downloads.DownloadItem);
    searchDownloads.mockResolvedValue([
      {
        id: 17,
        state: "complete",
        bytesReceived: 1_000,
        totalBytes: 1_000,
      },
    ]);

    await expect(
      readMobileNavigationDownloadStatus("drive-item"),
    ).resolves.toMatchObject({
      state: "complete",
      downloadId: 17,
      bytesReceived: 1_000,
    });
  });

  it("cancels and removes a matched Android download", async () => {
    await prepareMobileNavigationDownload(attachment);
    await claimMobileNavigationDownload({
      id: 17,
      url: "https://files.test/download",
      filename: "extension.crx",
      state: "in_progress",
      bytesReceived: 100,
      totalBytes: 1_000,
    } as Browser.downloads.DownloadItem);

    await cancelMobileNavigationDownload("drive-item");

    expect(cancel).toHaveBeenCalledWith(17);
    expect(removeFile).toHaveBeenCalledWith(17);
    expect(erase).toHaveBeenCalledWith({ id: 17 });
    await expect(
      readMobileNavigationDownloadStatus("drive-item"),
    ).resolves.toBeUndefined();
  });
  it("retains download ownership across account changes and never claims by filename alone", async () => {
    configureAccountContext("A");
    getAttachmentDownloadUrl.mockResolvedValueOnce(
      "https://files.test/account-a",
    );
    await prepareMobileNavigationDownload(attachment);
    configureAccountContext("B");
    getAttachmentDownloadUrl.mockResolvedValueOnce(
      "https://files.test/account-b",
    );
    await prepareMobileNavigationDownload(attachment);
    await claimMobileNavigationDownload({
      id: 18,
      url: "https://files.test/unrelated",
      filename: "extension.crx",
      state: "complete",
      startTime: new Date().toISOString(),
      bytesReceived: 1000,
      totalBytes: 1000,
    } as Browser.downloads.DownloadItem);
    expect(
      (await readMobileNavigationDownloadStatus("drive-item"))?.state,
    ).toBe("waiting");
    await claimMobileNavigationDownload({
      id: 17,
      url: "https://files.test/account-a",
      filename: "extension.crx",
      state: "complete",
      bytesReceived: 1000,
      totalBytes: 1000,
    } as Browser.downloads.DownloadItem);
    expect(
      (await readMobileNavigationDownloadStatus("drive-item"))?.state,
    ).toBe("waiting");
    configureAccountContext("A");
    expect(
      (await readMobileNavigationDownloadStatus("drive-item"))?.downloadId,
    ).toBe(17);
    await removeMobileAccountTasks("A");
    expect(
      await readMobileNavigationDownloadStatus("drive-item"),
    ).toBeUndefined();
    expect(removeFile).not.toHaveBeenCalled();
    configureAccountContext("B");
    expect(
      (await readMobileNavigationDownloadStatus("drive-item"))?.state,
    ).toBe("waiting");
  });
});
