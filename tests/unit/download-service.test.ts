import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadStore = vi.hoisted(() => ({
  deleteDownloadRecord: vi.fn(),
  getDownloadRecord: vi.fn(),
  markDownloadOpened: vi.fn(),
  putDownloadRecord: vi.fn(),
}));
const readAttachmentDataUrl = vi.hoisted(() => vi.fn());
type TestDownloadItem = {
  id: number;
  filename: string;
  state: "complete" | "in_progress" | "interrupted";
  exists: boolean;
};
const searchDownloads = vi.fn(async (): Promise<TestDownloadItem[]> => []);

vi.mock("../../src/infrastructure/indexed-db/downloads", () => downloadStore);
vi.mock("../../src/infrastructure/onedrive/file-uploader", () => ({
  readAttachmentDataUrl,
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
    readAttachmentDataUrl.mockResolvedValue(
      "data:application/pdf;base64,aGVsbG8=",
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

    await expect(openOrDownloadAttachment(attachment, false)).resolves.toBe(
      "opened",
    );
    expect(browser.downloads.open).toHaveBeenCalledWith(4);
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

    await expect(openOrDownloadAttachment(attachment, false)).resolves.toBe(
      "downloaded",
    );
    expect(browser.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("sanitizes unsafe path characters", () => {
    expect(sanitizeDownloadFilename("../bad:name?.txt")).toBe("_bad_name_.txt");
  });
});
