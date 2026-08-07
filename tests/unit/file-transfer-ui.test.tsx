import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PendingFileList,
  type PendingFile,
} from "../../entrypoints/sidepanel/App";

const file = new File(["hello"], "hello.txt", { type: "text/plain" });

describe("file transfer failure UI", () => {
  afterEach(cleanup);

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
