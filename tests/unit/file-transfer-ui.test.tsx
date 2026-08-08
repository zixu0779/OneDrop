import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/infrastructure/indexed-db/downloads", () => ({
  deleteDownloadRecord: vi.fn().mockResolvedValue(undefined),
  getDownloadRecord: vi.fn().mockResolvedValue(undefined),
  markDownloadOpened: vi.fn().mockResolvedValue(1),
}));

import {
  FileAttachment,
  ImageAttachment,
  CommittedMessageItem,
  PendingFileList,
  UploadingFileMessageItem,
  groupTimelineItems,
  type PendingFile,
} from "../../entrypoints/sidepanel/App";
import {
  deleteDownloadRecord,
  getDownloadRecord,
} from "../../src/infrastructure/indexed-db/downloads";

const file = new File(["hello"], "hello.txt", { type: "text/plain" });

describe("file transfer failure UI", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a grey image overlay and Resend after image upload failure", () => {
    renderList({
      id: "image",
      createdAt: "2026-08-03T00:00:00.000Z",
      file: new File(["image"], "photo.png", { type: "image/png" }),
      previewUrl: "blob:preview",
      isImage: true,
      status: "upload-failed",
      error: "offline",
    });

    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend" })).toBeInTheDocument();
    expect(screen.getByLabelText("Transfer error")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Transfer error" }),
    ).not.toBeInTheDocument();
  });

  it("shows red upload text beneath a regular file name", () => {
    renderList({
      id: "file",
      createdAt: "2026-08-03T00:00:00.000Z",
      file,
      isImage: false,
      status: "upload-failed",
      error: "offline",
    });

    expect(screen.getByText("hello.txt")).toBeInTheDocument();
    expect(screen.queryByText("5 B")).not.toBeInTheDocument();
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend" })).toBeInTheDocument();
  });

  it("keeps a failed transfer before a later committed message", () => {
    const pending: PendingFile = {
      id: "01989f5e-7700-7000-8000-000000000001",
      createdAt: "2026-08-03T00:00:00.000Z",
      file,
      isImage: false,
      status: "upload-failed",
    };
    const groups = groupTimelineItems(
      [
        {
          schemaVersion: 1,
          id: "01989f5e-7700-7000-8000-000000000002",
          type: "text",
          text: "sent later",
          createdAt: "2026-08-03T00:01:00.000Z",
          senderDeviceId: "01989f5e-7700-7000-8000-000000000099",
        },
      ],
      [pending],
      "01989f5e-7700-7000-8000-000000000099",
    );

    expect(
      groups.flatMap((group) =>
        group.items.map((item) =>
          item.kind === "message" ? item.message.id : item.pending.id,
        ),
      ),
    ).toEqual([
      "01989f5e-7700-7000-8000-000000000001",
      "01989f5e-7700-7000-8000-000000000002",
    ]);
  });

  it("marks a committed regular file unavailable when its DriveItem is missing", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          type: "files/availability",
          exists: false,
        }),
      },
    });

    render(
      <FileAttachment
        attachment={{
          driveItemId: "missing-file",
          name: "deleted.txt",
          size: 5,
          mimeType: "text/plain",
        }}
      />,
    );

    await screen.findByLabelText("Attachment error");
    expect(screen.getAllByText("Not found in OneDrive")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Attachment error" }),
    ).not.toBeInTheDocument();
  });

  it("shows an explicit checking state while validating a regular file", () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    });

    render(
      <FileAttachment
        attachment={{
          driveItemId: "checking-file",
          name: "document.pdf",
          size: 1024,
          mimeType: "application/pdf",
        }}
      />,
    );

    expect(
      screen.getByLabelText("Checking file availability"),
    ).toBeInTheDocument();
  });

  it("reveals normal attachment actions after availability checking finishes", async () => {
    let resolveCheck: ((value: unknown) => void) | undefined;
    vi.stubGlobal("browser", {
      downloads: { search: vi.fn() },
      runtime: {
        sendMessage: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveCheck = resolve;
            }),
        ),
      },
    });

    render(
      <CommittedMessageItem
        checkVersion={0}
        isOwn
        message={{
          schemaVersion: 1,
          id: "01989f5e-7700-7000-8000-000000000050",
          type: "file",
          createdAt: "2026-08-03T00:00:00.000Z",
          attachment: {
            driveItemId: "available-file",
            name: "available.pdf",
            size: 1024,
            mimeType: "application/pdf",
          },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "More message actions" }),
    ).not.toBeInTheDocument();
    resolveCheck?.({
      ok: true,
      type: "files/availability",
      exists: true,
    });

    expect(
      await screen.findByRole("button", { name: "More message actions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  it("uses an image-specific missing state with a static error marker", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          type: "files/availability",
          exists: false,
        }),
      },
    });

    render(
      <ImageAttachment
        attachment={{
          driveItemId: "missing-image",
          name: "deleted.png",
          size: 5,
          mimeType: "image/png",
        }}
      />,
    );

    expect(
      await screen.findByText("Not found in OneDrive"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Attachment error")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Attachment error" }),
    ).not.toBeInTheDocument();
  });

  it("reports a deleted local file on the first quick-open attempt", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "downloaded-file",
      downloadId: 42,
      cloudName: "downloaded.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce([{ id: 42, state: "complete", exists: true }])
      .mockResolvedValueOnce([{ id: 42, state: "complete", exists: false }]);
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("browser", {
      downloads: { open, search },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          type: "files/availability",
          exists: true,
        }),
      },
    });

    render(
      <CommittedMessageItem
        checkVersion={0}
        isOwn
        message={{
          schemaVersion: 1,
          id: "01989f5e-7700-7000-8000-000000000060",
          type: "file",
          createdAt: "2026-08-03T00:00:00.000Z",
          attachment: {
            driveItemId: "downloaded-file",
            name: "downloaded.pdf",
            size: 1024,
            mimeType: "application/pdf",
          },
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open file" }));

    expect(
      await screen.findByText(
        "The local file no longer exists. Please download it again.",
      ),
    ).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(deleteDownloadRecord).toHaveBeenCalledWith("downloaded-file");
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  it("gives an unresponsive transfer its own refresh and menu controls", () => {
    const onRefresh = vi.fn();
    render(
      <UploadingFileMessageItem
        isOwn
        isRefreshing={false}
        message={{
          schemaVersion: 1,
          id: "01989f5e-7700-7000-8000-000000000070",
          type: "file-uploading",
          createdAt: "2026-08-03T00:00:00.000Z",
          pendingAttachment: {
            name: "unresponsive.zip",
            size: 4096,
            mimeType: "application/zip",
          },
        }}
        onRefresh={onRefresh}
        unresponsive
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh this transfer" }),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "More message actions" }),
    ).toBeInTheDocument();
  });
});

function renderList(item: PendingFile) {
  render(<PendingFileList items={[item]} onResend={vi.fn()} />);
}
