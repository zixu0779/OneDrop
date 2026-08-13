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
  error?: string;
};
const searchDownloads = vi.fn<
  (query?: { id?: number }) => Promise<TestDownloadItem[]>
>(async () => []);
const downloadChangedListeners = new Set<(delta: { id: number }) => void>();

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
    downloadChangedListeners.clear();
    vi.stubGlobal("browser", {
      downloads: {
        download: vi.fn().mockResolvedValue(7),
        open: vi.fn().mockResolvedValue(undefined),
        search: searchDownloads,
        onChanged: {
          addListener: vi.fn((listener) =>
            downloadChangedListeners.add(listener),
          ),
          removeListener: vi.fn((listener) =>
            downloadChangedListeners.delete(listener),
          ),
        },
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

  it("chooses the next numbered filename when a local file already exists", async () => {
    searchDownloads.mockImplementation(async (query) =>
      query?.id === 7
        ? [
            {
              id: 7,
              filename: "/Downloads/report (1).pdf",
              state: "complete",
              exists: true,
            },
          ]
        : [
            {
              id: 3,
              filename: "/Downloads/report.pdf",
              state: "complete",
              exists: true,
            },
          ],
    );

    await openOrDownloadAttachment(attachment, false);

    expect(browser.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "report (1).pdf" }),
    );
  });

  it("automatically retries FILE_EXISTS with a different filename", async () => {
    vi.mocked(browser.downloads.download as () => Promise<number>)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8);
    searchDownloads.mockImplementation(async (query) => {
      if (!query?.id) return [];
      return query.id === 7
        ? [
            {
              id: 7,
              filename: "/Downloads/report.pdf",
              state: "interrupted",
              exists: false,
              error: "FILE_EXISTS",
            },
          ]
        : [
            {
              id: 8,
              filename: "/Downloads/report (1).pdf",
              state: "complete",
              exists: true,
            },
          ];
    });

    await expect(openOrDownloadAttachment(attachment, false)).resolves.toEqual({
      action: "downloaded",
      downloadId: 8,
    });
    expect(browser.downloads.download).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ filename: "report.pdf" }),
    );
    expect(browser.downloads.download).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filename: "report (1).pdf" }),
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

  it("does not record a download Edge interrupts because the file exists", async () => {
    searchDownloads.mockResolvedValue([
      {
        id: 7,
        filename: "/Downloads/report.pdf",
        state: "interrupted",
        exists: false,
        error: "FILE_EXISTS",
      },
    ]);

    await expect(openOrDownloadAttachment(attachment, false)).rejects.toThrow(
      "file already exists",
    );
    expect(downloadStore.putDownloadRecord).not.toHaveBeenCalled();
  });

  it("records an in-progress download only after Edge reports completion", async () => {
    let state: TestDownloadItem["state"] = "in_progress";
    searchDownloads.mockImplementation(async () => [
      {
        id: 7,
        filename: "/Downloads/report (1).pdf",
        state,
        exists: true,
      },
    ]);

    const result = openOrDownloadAttachment(attachment, false);
    await vi.waitFor(() => expect(downloadChangedListeners.size).toBe(1));
    expect(downloadStore.putDownloadRecord).not.toHaveBeenCalled();
    state = "complete";
    for (const listener of downloadChangedListeners) listener({ id: 7 });

    await expect(result).resolves.toEqual({
      action: "downloaded",
      downloadId: 7,
    });
    expect(downloadStore.putDownloadRecord).toHaveBeenCalledOnce();
    expect(downloadChangedListeners.size).toBe(0);
  });

  it("sanitizes unsafe path characters", () => {
    expect(sanitizeDownloadFilename("../bad:name?.txt")).toBe("_bad_name_.txt");
  });
});
