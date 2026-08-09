import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadStore = vi.hoisted(() => ({
  deleteDownloadRecord: vi.fn(),
  getDownloadRecord: vi.fn(),
  markDownloadOpened: vi.fn(),
  putDownloadRecord: vi.fn(),
}));
const getAttachmentDownloadUrl = vi.hoisted(() => vi.fn());
type TestDownloadItem = {
  id: number;
  filename: string;
  state: "complete" | "in_progress" | "interrupted";
  exists: boolean;
};
const searchDownloads = vi.fn(async (): Promise<TestDownloadItem[]> => []);

vi.mock("../../src/infrastructure/indexed-db/downloads", () => downloadStore);
vi.mock("../../src/infrastructure/onedrive/file-uploader", () => ({
  getAttachmentDownloadUrl,
}));

import {
  openOrDownloadAttachment,
  sanitizeDownloadFilename,
} from "../../src/features/downloads/download-service";

const attachment = {
  driveItemId: "drive-item",
  name: "report.pdf",
  size: 5,
  mimeType: "application/pdf",
};

describe("download service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("browser", {
      downloads: {
        download: vi.fn().mockResolvedValue(7),
        open: vi.fn().mockResolvedValue(undefined),
        search: searchDownloads,
      },
    });
    getAttachmentDownloadUrl.mockResolvedValue(
      "https://download.example/temporary-file",
    );
  });

  it("opens a completed local download instead of downloading it again", async () => {
    downloadStore.getDownloadRecord.mockResolvedValue({
      driveItemId: "drive-item",
      downloadId: 4,
    });
    searchDownloads.mockResolvedValue([
      {
        id: 4,
        filename: "/Downloads/report.pdf",
        state: "complete",
        exists: true,
      },
    ]);

    await expect(openOrDownloadAttachment(attachment, false)).resolves.toEqual({
      action: "open",
      downloadId: 4,
    });
    expect(browser.downloads.open).not.toHaveBeenCalled();
    expect(browser.downloads.download).not.toHaveBeenCalled();
  });

  it("downloads with a unique filename and records the browser download", async () => {
    downloadStore.getDownloadRecord.mockResolvedValue(undefined);
    searchDownloads.mockResolvedValue([
      {
        id: 7,
        filename: "/Downloads/report (1).pdf",
        state: "complete",
        exists: true,
      },
    ]);

    await expect(openOrDownloadAttachment(attachment, false)).resolves.toEqual({
      action: "downloaded",
      downloadId: 7,
    });
    expect(browser.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://download.example/temporary-file",
        filename: "report.pdf",
        conflictAction: "uniquify",
        saveAs: false,
      }),
    );
    expect(downloadStore.putDownloadRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        driveItemId: "drive-item",
        downloadId: 7,
        localFilename: "/Downloads/report (1).pdf",
      }),
    );
  });

  it("forces a fresh download after a registered local file cannot be opened", async () => {
    searchDownloads.mockResolvedValue([
      {
        id: 7,
        filename: "/Downloads/report (2).pdf",
        state: "complete",
        exists: true,
      },
    ]);

    await expect(
      openOrDownloadAttachment(attachment, false, true),
    ).resolves.toEqual({ action: "downloaded", downloadId: 7 });
    expect(downloadStore.getDownloadRecord).not.toHaveBeenCalled();
    expect(browser.downloads.download).toHaveBeenCalledOnce();
  });

  it("sanitizes unsafe path characters", () => {
    expect(sanitizeDownloadFilename("../bad:name?.txt")).toBe("_bad_name_.txt");
  });
});
