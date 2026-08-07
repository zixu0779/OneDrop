import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileAttachment,
  ImageAttachment,
  PendingFileList,
  groupTimelineItems,
  type PendingFile,
} from "../../entrypoints/sidepanel/App";

const file = new File(["hello"], "hello.txt", { type: "text/plain" });

describe("file transfer failure UI", () => {
  afterEach(() => {
    cleanup();
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

  it("uses Retry when only metadata commit failed", () => {
    renderList({
      id: "commit",
      createdAt: "2026-08-03T00:00:00.000Z",
      file,
      isImage: false,
      status: "commit-failed",
      error: "conflict",
      attachment: {
        driveItemId: "uploaded",
        name: "hello.txt",
        size: 5,
        mimeType: "text/plain",
      },
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Upload failed")).not.toBeInTheDocument();
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
});

function renderList(item: PendingFile) {
  render(
    <PendingFileList
      items={[item]}
      onCommitRetry={vi.fn()}
      onResend={vi.fn()}
    />,
  );
}
