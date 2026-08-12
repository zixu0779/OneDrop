import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    vi.useRealTimers();
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

  it("shows large-file progress and allows cancellation", () => {
    const onCancel = vi.fn();
    render(
      <PendingFileList
        items={[
          {
            id: "large-file",
            createdAt: "2026-08-03T00:00:00.000Z",
            file: new File([new Uint8Array(5 * 1024 * 1024)], "large.zip"),
            isImage: false,
            status: "uploading",
            progress: 42,
          },
        ]}
        onCancel={onCancel}
        onResend={vi.fn()}
      />,
    );

    expect(screen.getByText("42% · 5.0 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(onCancel).toHaveBeenCalledWith("large-file");
  });

  it("predicts within a segment and catches up after confirmation", () => {
    vi.useFakeTimers();
    const item: PendingFile = {
      id: "large-file",
      createdAt: "2026-08-03T00:00:00.000Z",
      file: new File([new Uint8Array(5 * 1024 * 1024)], "large.zip"),
      isImage: false,
      status: "uploading",
      progress: 0,
      progressTarget: 50,
    };
    const view = render(<PendingFileList items={[item]} onResend={vi.fn()} />);
    expect(
      screen.queryByRole("progressbar", { name: "Upload progress" }),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    const predicted = Number.parseInt(
      screen.getByText(/% · 5\.0 MB/u).textContent ?? "0",
      10,
    );
    expect(predicted).toBeGreaterThan(0);
    expect(predicted).toBeLessThan(50);
    expect(
      screen.getByRole("progressbar", { name: "Upload progress" }),
    ).toHaveAttribute("aria-valuenow", String(predicted));

    view.rerender(
      <PendingFileList
        items={[{ ...item, progress: 50, progressTarget: 100 }]}
        onResend={vi.fn()}
      />,
    );
    act(() => vi.advanceTimersByTime(1_000));
    const caughtUp = Number.parseInt(
      screen.getByText(/% · 5\.0 MB/u).textContent ?? "0",
      10,
    );
    expect(caughtUp).toBeGreaterThanOrEqual(50);
    expect(caughtUp).toBeLessThan(100);
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

    const checkingActions = screen.getByRole("button", {
      name: "Checking message actions",
    });
    expect(checkingActions).toBeDisabled();
    expect(checkingActions).toHaveClass("message-more-button-checking");
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

  it("fades the floating attachment error tooltip in and out", async () => {
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
      <CommittedMessageItem
        checkVersion={0}
        isOwn
        message={{
          schemaVersion: 1,
          id: "01989f5e-7700-7000-8000-000000000071",
          type: "file",
          createdAt: "2026-08-03T00:00:00.000Z",
          attachment: {
            driveItemId: "missing-tooltip-file",
            name: "missing.pdf",
            size: 1024,
            mimeType: "application/pdf",
          },
        }}
      />,
    );

    const error = await screen.findByLabelText("Attachment error");
    fireEvent.mouseEnter(error.parentElement!);
    await waitFor(() =>
      expect(document.querySelector(".floating-error-tooltip")).toHaveClass(
        "is-visible",
      ),
    );

    fireEvent.mouseLeave(error.parentElement!);
    expect(document.querySelector(".floating-error-tooltip")).not.toHaveClass(
      "is-visible",
    );
    await waitFor(() =>
      expect(
        document.querySelector(".floating-error-tooltip"),
      ).not.toBeInTheDocument(),
    );
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

  it("keeps local Open adjacent to Open in OneDrive and shows the folder action", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "downloaded-file",
      downloadId: 42,
      cloudName: "downloaded.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    vi.stubGlobal("browser", {
      downloads: {
        search: vi
          .fn()
          .mockResolvedValue([{ id: 42, state: "complete", exists: true }]),
      },
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
          id: "01989f5e-7700-7000-8000-000000000061",
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

    fireEvent.click(
      await screen.findByRole("button", { name: "More message actions" }),
    );
    const actions = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(actions).toEqual([
      "Open",
      "Open in OneDrive",
      "Save as",
      "Show in folder",
      "Delete",
    ]);
  });

  it("does not redownload when the menu Open action finds the local file missing", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "missing-local-file",
      downloadId: 43,
      cloudName: "missing.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce([{ id: 43, state: "complete", exists: true }])
      .mockResolvedValueOnce([{ id: 43, state: "complete", exists: false }]);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      type: "files/availability",
      exists: true,
    });
    vi.stubGlobal("browser", {
      downloads: { open: vi.fn(), search },
      runtime: { sendMessage },
    });

    renderDownloadedFile("missing-local-file", "missing.pdf");
    fireEvent.click(
      await screen.findByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));

    expect(
      await screen.findByText(
        "The local file no longer exists. Please download it again.",
      ),
    ).toBeInTheDocument();
    expect(deleteDownloadRecord).toHaveBeenCalledWith("missing-local-file");
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "files/open-local" }),
    );
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  it("clears stale download state when Show in folder finds the file missing", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "missing-folder-file",
      downloadId: 44,
      cloudName: "missing-folder.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce([{ id: 44, state: "complete", exists: true }])
      .mockResolvedValueOnce([{ id: 44, state: "complete", exists: false }]);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      type: "files/availability",
      exists: true,
    });
    vi.stubGlobal("browser", {
      downloads: { search },
      runtime: { sendMessage },
    });

    renderDownloadedFile("missing-folder-file", "missing-folder.pdf");
    fireEvent.click(
      await screen.findByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));

    expect(
      await screen.findByText(
        "The local file no longer exists. Please download it again.",
      ),
    ).toBeInTheDocument();
    expect(deleteDownloadRecord).toHaveBeenCalledWith("missing-folder-file");
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "files/show-in-folder" }),
    );
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  it("treats a failed Open as a stale local download after a cached existence check", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "stale-open-file",
      downloadId: 45,
      cloudName: "stale-open.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const search = vi
      .fn()
      .mockResolvedValue([{ id: 45, state: "complete", exists: true }]);
    vi.stubGlobal("browser", {
      downloads: {
        open: vi.fn().mockRejectedValue(new Error("File removed")),
        search,
      },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          type: "files/availability",
          exists: true,
        }),
      },
    });

    renderDownloadedFile("stale-open-file", "stale-open.pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Open file" }));

    expect(
      await screen.findByText(
        "The local file no longer exists. Please download it again.",
      ),
    ).toBeInTheDocument();
    expect(deleteDownloadRecord).toHaveBeenCalledWith("stale-open-file");
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  it("uses the post-show download check to catch a stale Finder deletion", async () => {
    vi.mocked(getDownloadRecord).mockResolvedValueOnce({
      driveItemId: "stale-folder-file",
      downloadId: 46,
      cloudName: "stale-folder.pdf",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const sendMessage = vi
      .fn()
      .mockImplementation((request) =>
        Promise.resolve(
          request.type === "files/show-in-folder"
            ? { ok: true, type: "files/folder-shown", exists: false }
            : { ok: true, type: "files/availability", exists: true },
        ),
      );
    vi.stubGlobal("browser", {
      downloads: {
        search: vi
          .fn()
          .mockResolvedValue([{ id: 46, state: "complete", exists: true }]),
      },
      runtime: { sendMessage },
    });

    renderDownloadedFile("stale-folder-file", "stale-folder.pdf");
    fireEvent.click(
      await screen.findByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));

    expect(
      await screen.findByText(
        "The local file no longer exists. Please download it again.",
      ),
    ).toBeInTheDocument();
    expect(deleteDownloadRecord).toHaveBeenCalledWith("stale-folder-file");
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

function renderDownloadedFile(driveItemId: string, name: string) {
  render(
    <CommittedMessageItem
      checkVersion={0}
      isOwn
      message={{
        schemaVersion: 1,
        id: crypto.randomUUID(),
        type: "file",
        createdAt: "2026-08-03T00:00:00.000Z",
        attachment: {
          driveItemId,
          name,
          size: 1024,
          mimeType: "application/pdf",
        },
      }}
    />,
  );
}
