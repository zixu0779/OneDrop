import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pendingTextStore = vi.hoisted(() => ({
  deletePendingText: vi.fn().mockResolvedValue(undefined),
  listPendingTexts: vi.fn().mockResolvedValue([]),
  putPendingText: vi.fn().mockResolvedValue("pending-text"),
  updatePendingText: vi.fn().mockResolvedValue(1),
}));

const pendingTransferStore = vi.hoisted(() => ({
  deletePendingTransfer: vi.fn().mockResolvedValue(undefined),
  listPendingTransfers: vi.fn().mockResolvedValue([]),
  putPendingTransfer: vi.fn().mockResolvedValue("pending-transfer"),
  updatePendingTransfer: vi.fn().mockResolvedValue(1),
}));

vi.mock(
  "../../src/infrastructure/indexed-db/pending-texts",
  () => pendingTextStore,
);
vi.mock(
  "../../src/infrastructure/indexed-db/pending-transfers",
  () => pendingTransferStore,
);

import {
  App,
  getFloatingMenuPosition,
  groupMessages,
  shouldApplyMonthRead,
} from "../../entrypoints/sidepanel/App";
import type {
  RuntimeRequest,
  RuntimeResponse,
} from "../../src/contracts/runtime-messages";
import { createTextMessage } from "../../src/features/messages/create-text-message";

let archiveCheckNotices: Array<{
  month: string;
  phase: "failed" | "running" | "succeeded";
}> = [];
let archiveMessageListener:
  | ((message: {
      type: "archives/event";
      notice: (typeof archiveCheckNotices)[number];
    }) => void)
  | undefined;

const defaultSendMessage = async (
  request: RuntimeRequest,
): Promise<RuntimeResponse> => {
  switch (request.type) {
    case "auth/status":
      return {
        ok: true,
        type: "auth/status",
        status: {
          state: "signed-in",
          redirectUri: "https://extension.chromiumapp.org/auth",
          account: { displayName: "OneDrop User" },
          expiresAt: "2026-08-03T12:00:00.000Z",
        },
      };
    case "device/id":
      return {
        ok: true,
        type: "device/id",
        deviceId: "01989f5e-7700-7000-8000-000000000099",
      };
    case "onedrive/verify-app-folder":
      return {
        ok: true,
        type: "onedrive/app-folder",
        appFolder: { id: "folder-id", name: "OneDrop" },
      };
    case "messages/read-current-month":
    case "messages/send-text":
      return {
        ok: true,
        type: "messages/month",
        result: {
          state: "loaded",
          month: "2026-08",
          eTag: "etag",
          messages: [
            {
              schemaVersion: 1,
              id: "01989f5e-7700-7000-8000-000000000001",
              type: "text",
              text: "from this Edge",
              createdAt: "2026-08-03T00:00:00.000Z",
              senderDeviceId: "01989f5e-7700-7000-8000-000000000099",
            },
            {
              schemaVersion: 1,
              id: "01989f5e-7700-7000-8000-000000000002",
              type: "text",
              text: "from another Edge https://example.com/path?q=1.",
              createdAt: "2026-08-03T00:00:01.000Z",
              senderDeviceId: "01989f5e-7700-7000-8000-000000000100",
            },
          ],
        },
      };
    case "messages/read-month":
      return {
        ok: true,
        type: "messages/month",
        result: {
          state: "loaded",
          month: "2026-07",
          eTag: "history-etag",
          messages: [
            {
              schemaVersion: 1,
              id: "01989f5e-7700-7000-8000-000000000003",
              type: "text",
              text: "from July",
              createdAt: "2026-07-31T23:00:00.000Z",
            },
          ],
        },
      };
    case "messages/delete":
      return {
        ok: true,
        type: "messages/deleted",
        result: {
          state: "loaded",
          month: request.month,
          eTag: "deleted-etag",
          messages: [],
        },
      };
    case "archives/check":
      return {
        ok: true,
        type: "archives/notices",
        notices: archiveCheckNotices,
      };
    case "archives/retry":
      return {
        ok: true,
        type: "archives/notice",
        notice: { month: "2026-07", phase: "succeeded" },
      };
    case "archives/dismiss":
      return { ok: true, type: "archives/dismissed" };
    case "deleted-data/clean-now":
      return {
        ok: true,
        type: "deleted-data/cleaned",
        messages: 2,
        attachments: 1,
      };
    case "deleted-data/read":
      return {
        ok: true,
        type: "deleted-data/items",
        items: [
          {
            deletedAt: "2026-08-14T10:00:00.000Z",
            originalMonth: "2026-08",
            kind: "text",
            message: {
              schemaVersion: 1,
              id: "01989f5e-7700-7000-8000-000000000881",
              type: "text",
              text: "deleted text message",
              createdAt: "2026-08-10T08:30:00.000Z",
            },
          },
        ],
      };
    case "deleted-data/restore":
      return {
        ok: true,
        type: "deleted-data/restored",
        item: {
          deletedAt: "2026-08-14T10:00:00.000Z",
          originalMonth: "2026-08",
          kind: "text",
          message: {
            schemaVersion: 1,
            id: request.messageId,
            type: "text",
            text: "deleted text message",
            createdAt: "2026-08-10T08:30:00.000Z",
          },
        },
        result: {
          state: "loaded",
          month: request.month,
          eTag: "restored-etag",
          messages: [],
        },
      };
    default:
      throw new Error("Unexpected request");
  }
};
const sendMessage = vi.fn(defaultSendMessage);

describe("side panel message composer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    sendMessage.mockClear();
    sendMessage.mockImplementation(defaultSendMessage);
    archiveCheckNotices = [];
    archiveMessageListener = undefined;
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener) => {
            archiveMessageListener = listener;
          }),
          removeListener: vi.fn(),
        },
      },
    });
  });

  it("loads OneDrive in the background without showing validation controls", async () => {
    await screenForComposer();

    expect(
      screen.queryByText("OneDrive App Folder verified"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Read current month")).not.toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "onedrive/verify-app-folder",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "messages/read-current-month",
    });
  });

  it("does not start a competing foreground read during initial restoration", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    let resolveInitialRead!: (response: RuntimeResponse) => void;
    const initialRead = new Promise<RuntimeResponse>((resolve) => {
      resolveInitialRead = resolve;
    });
    sendMessage.mockImplementation((request: RuntimeRequest) =>
      request.type === "messages/read-current-month"
        ? initialRead
        : originalImplementation(request),
    );

    render(<App />);
    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === "messages/read-current-month",
        ),
      ).toHaveLength(1),
    );
    expect(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    ).toBeDisabled();
    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 31_000);
    fireEvent.focus(window);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-current-month",
      ),
    ).toHaveLength(1);

    resolveInitialRead(
      await originalImplementation({
        type: "messages/read-current-month",
      }),
    );
    expect(await screen.findByText("from this Edge")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh messages and files" }),
      ).not.toBeDisabled(),
    );
  });

  it("shows a newer network snapshot during the first restoration", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    let currentMonthReads = 0;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "messages/read-current-month") {
        return originalImplementation(request);
      }
      currentMonthReads += 1;
      return {
        ok: true,
        type: "messages/month",
        result: {
          state: "loaded",
          month: "2026-08",
          eTag: "new-network-etag",
          messages: [
            {
              schemaVersion: 1,
              id: "01989f5e-7700-7000-8000-000000000777",
              type: "text",
              text: "new from Android on first restoration",
              createdAt: "2026-08-03T00:01:00.000Z",
              senderDeviceId: "01989f5e-7700-7000-8000-000000000777",
            },
          ],
        },
      };
    });

    render(<App />);

    expect(
      await screen.findByText("new from Android on first restoration"),
    ).toBeInTheDocument();
    expect(currentMonthReads).toBe(1);
  });

  it("warns before manual cleanup and finishes without a success dialog", async () => {
    await screenForComposer();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Clean up now" }),
    );

    expect(
      screen.getByText(
        /bypasses the 10-day recovery period and cannot be undone/iu,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "deleted-data/clean-now",
      }),
    );
    expect(
      screen.queryByText("Deleted data cleanup has completed successfully."),
    ).not.toBeInTheDocument();
  });

  it("opens the recycle bin and restores a deleted message", async () => {
    await screenForComposer();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));

    expect(await screen.findByText("deleted text message")).toBeInTheDocument();
    expect(screen.getByText("Text message")).toBeInTheDocument();
    expect(screen.getByText(/Sent Aug 10, 2026/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(
        screen.queryByText("deleted text message"),
      ).not.toBeInTheDocument(),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: "deleted-data/restore",
      messageId: "01989f5e-7700-7000-8000-000000000881",
      month: "2026-08",
    });
  });

  it("returns from the recycle bin to the previous timeline position", async () => {
    await screenForComposer();
    const timeline = document.querySelector<HTMLDivElement>(".message-scroll")!;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 400,
    });
    timeline.scrollTop = 137;
    fireEvent.scroll(timeline);

    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));
    await screen.findByText("deleted text message");
    fireEvent.click(screen.getByRole("button", { name: "Back to messages" }));

    await waitFor(() =>
      expect(
        document.querySelector<HTMLDivElement>(".message-scroll")?.scrollTop,
      ).toBe(137),
    );
  });

  it("loads a real image preview for a visible deleted image", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "deleted-data/read") {
        return {
          ok: true,
          type: "deleted-data/items",
          items: [
            {
              deletedAt: "2026-08-14T10:00:00.000Z",
              originalMonth: "2026-08",
              kind: "image",
              message: {
                schemaVersion: 1,
                id: "01989f5e-7700-7000-8000-000000000882",
                type: "file",
                createdAt: "2026-08-10T08:30:00.000Z",
                attachment: {
                  driveItemId: "deleted-image-item",
                  name: "deleted-image.png",
                  size: 1200,
                  mimeType: "image/png",
                },
              },
            },
          ],
        };
      }
      if (request.type === "files/read-preview") {
        return {
          ok: true,
          type: "files/preview",
          dataUrl: "data:image/png;base64,cHJldmlldw==",
        };
      }
      return originalImplementation(request);
    });

    await screenForComposer();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));

    expect(await screen.findByText("deleted-image.png")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLImageElement>(".recycle-bin-image-icon img")
          ?.src,
      ).toContain("data:image/png"),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: "files/read-preview",
      driveItemId: "deleted-image-item",
      mimeType: "image/png",
    });
  });

  it("offers Retry after manual cleanup fails and replaces failure with success", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    let attempts = 0;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "deleted-data/clean-now") {
        return originalImplementation(request);
      }
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: "Temporary cleanup failure." }
        : {
            ok: true,
            type: "deleted-data/cleaned",
            messages: 1,
            attachments: 0,
          };
    });
    try {
      await screenForComposer();
      fireEvent.click(
        screen.getByRole("button", {
          name: /one@example.com|sycamore|microsoft account/iu,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Clean up now" }),
      );
      expect(
        screen
          .getByRole("button", { name: "Clean up now" })
          .querySelector(".cleanup-broom-icon"),
      ).not.toHaveClass("is-animated");
      fireEvent.click(screen.getByRole("button", { name: "Clean up" }));

      expect(
        await screen.findByText("Temporary cleanup failure."),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => expect(attempts).toBe(2));
      expect(
        screen.queryByText("Temporary cleanup failure."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Deleted data cleanup has completed successfully."),
      ).not.toBeInTheDocument();
    } finally {
      sendMessage.mockImplementation(originalImplementation);
    }
  });

  it("shows non-blocking cleanup status in the account bar", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    let finishCleanup!: () => void;
    const cleanupResponse = new Promise<RuntimeResponse>((resolve) => {
      finishCleanup = () =>
        resolve({
          ok: true,
          type: "deleted-data/cleaned",
          messages: 1,
          attachments: 0,
        });
    });
    sendMessage.mockImplementation((request: RuntimeRequest) =>
      request.type === "deleted-data/clean-now"
        ? cleanupResponse
        : originalImplementation(request),
    );
    try {
      const composer = await screenForComposer();
      const accountButton = screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      });
      fireEvent.click(accountButton);
      fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Clean up now" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Clean up" }));

      expect(
        screen.queryByRole("status", { name: "Cleaning up deleted data" }),
      ).not.toBeInTheDocument();
      expect(composer).not.toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Refresh messages and files" }),
      ).not.toBeDisabled();

      expect(screen.getByRole("button", { name: "Cleaning…" })).toBeDisabled();
      expect(
        screen
          .getByRole("button", { name: "Cleaning…" })
          .querySelector(".cleanup-broom-icon"),
      ).toHaveClass("is-animated");

      fireEvent.click(screen.getByRole("button", { name: "Back to messages" }));
      const cleanupStatus = await screen.findByRole("status", {
        name: "Cleaning up deleted data",
      });
      fireEvent.mouseEnter(cleanupStatus.parentElement!);
      expect(
        await screen.findByText("Cleaning up deleted data…"),
      ).toBeInTheDocument();

      finishCleanup();
      await waitFor(() =>
        expect(
          screen.queryByRole("status", { name: "Cleaning up deleted data" }),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByText("Deleted data cleanup has completed successfully."),
      ).not.toBeInTheDocument();
    } finally {
      sendMessage.mockImplementation(originalImplementation);
    }
  });

  it("shows archive failure and replaces it with success after Retry", async () => {
    archiveCheckNotices = [{ month: "2026-07", phase: "failed" }];
    await screenForComposer();

    expect(
      await screen.findByText(
        "Couldn't archive the July 2026 message history. Your messages are unaffected.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText(
        "The July 2026 message history has been archived successfully.",
      ),
    ).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "archives/retry",
      month: "2026-07",
    });
  });

  it("accepts automatic archive status events without blocking messages", async () => {
    await screenForComposer();
    act(() => {
      archiveMessageListener?.({
        type: "archives/event",
        notice: { month: "2026-07", phase: "failed" },
      });
    });

    expect(
      await screen.findByText(
        "Couldn't archive the July 2026 message history. Your messages are unaffected.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Message")).not.toBeDisabled();
  });

  it("sends with Enter but preserves Shift+Enter for a newline", async () => {
    const composer = await screenForComposer();
    fireEvent.change(composer, { target: { value: "hello" } });

    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(sendMessage).not.toHaveBeenCalledWith({
      type: "messages/send-text",
      text: "hello",
    });

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "messages/send-text",
          text: "hello",
        }),
      ),
    );
  });

  it("does not perform another OneDrive read after a successful text write", async () => {
    const composer = await screenForComposer();
    const readsBeforeSend = sendMessage.mock.calls.filter(
      ([request]) => request.type === "messages/read-current-month",
    ).length;

    fireEvent.change(composer, {
      target: { value: "write response is enough" },
    });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "messages/send-text",
          text: "write response is enough",
        }),
      ),
    );

    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-current-month",
      ),
    ).toHaveLength(readsBeforeSend);
  });

  it("shows the send icon only while the composer has content", async () => {
    const composer = await screenForComposer();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "hello" } });
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });

  it("aligns this installation's messages separately from other devices", async () => {
    await screenForComposer();

    expect(screen.getByText("from this Edge").closest("li")).toHaveClass(
      "message-own",
    );
    expect(screen.getByText(/from another Edge/).closest("li")).not.toHaveClass(
      "message-own",
    );
    expect(
      screen.getByRole("link", { name: "https://example.com/path?q=1" }),
    ).toHaveAttribute("href", "https://example.com/path?q=1");
  });

  it("closes account details when the user clicks outside", async () => {
    await screenForComposer();
    expect(
      screen.queryByRole("button", { name: "Sign out…" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Switch account" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open OneDrive folder" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recycle bin/ })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Sign out…" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(screen.getByText("No other signed-in accounts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();

    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(
        screen.queryByText("No other signed-in accounts"),
      ).not.toBeInTheDocument(),
    );
  });

  it("positions the updated timeline at its exact scroll bottom", async () => {
    const composer = await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll");
    expect(timeline).not.toBeNull();
    Object.defineProperty(timeline!, "scrollHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.change(composer, { target: { value: "scroll to latest" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(timeline!.scrollTop).toBe(500));
  });

  it("preserves the timeline position when a message is deleted", async () => {
    await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
    timeline.scrollTop = 120;
    let timelineHeightReads = 0;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => (timelineHeightReads++ === 0 ? 500 : 440),
    });

    fireEvent.click(
      screen.getAllByRole("button", { name: "More message actions" })[0]!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "messages/delete",
        messageId: "01989f5e-7700-7000-8000-000000000001",
        month: "2026-08",
      }),
    );
    expect(timeline.scrollTop).toBe(60);
  });

  it("does not perform another OneDrive read after a successful deletion", async () => {
    await screenForComposer();
    const readsBeforeDelete = sendMessage.mock.calls.filter(
      ([request]) => request.type === "messages/read-current-month",
    ).length;

    fireEvent.click(
      screen.getAllByRole("button", { name: "More message actions" })[0]!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "messages/delete" }),
      ),
    );

    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-current-month",
      ),
    ).toHaveLength(readsBeforeDelete);
  });

  it("loads the previous month when the timeline reaches the top", async () => {
    await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll");
    expect(timeline).not.toBeNull();
    timeline!.scrollTop = 0;

    fireEvent.scroll(timeline!);

    expect(await screen.findByText("from July")).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "messages/read-month",
      month: "2026-07",
    });
    expect(timeline!.scrollTop).toBe(0);
  });

  it("keeps loaded historical months visible after synchronization", async () => {
    await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);
    expect(await screen.findByText("from July")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    );

    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === "messages/read-month",
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByText("from July")).toBeInTheDocument();
  });

  it("refreshes already loaded history during a stale foreground synchronization", async () => {
    await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);
    expect(await screen.findByText("from July")).toBeInTheDocument();
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-month",
      ),
    ).toHaveLength(1);

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 31_000);
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    fireEvent(document, new Event("visibilitychange"));
    visibilityState = "visible";
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === "messages/read-month",
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByText("from July")).toBeInTheDocument();
  });

  it("synchronizes when a retained panel receives focus again", async () => {
    await screenForComposer();
    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-current-month",
      ),
    ).toHaveLength(1);

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 31_000);
    fireEvent.focus(window);

    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === "messages/read-current-month",
        ),
      ).toHaveLength(2),
    );
  });

  it("keeps foreground focus synchronization throttled", async () => {
    await screenForComposer();
    fireEvent.focus(window);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      sendMessage.mock.calls.filter(
        ([request]) => request.type === "messages/read-current-month",
      ),
    ).toHaveLength(1);
  });

  it("does not add blank space for a missing earlier month", async () => {
    const originalImplementation = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async (request: RuntimeRequest) =>
      request.type === "messages/read-month"
        ? {
            ok: true,
            type: "messages/month",
            result: { state: "missing", month: "2026-07" },
          }
        : originalImplementation(request),
    );
    await screenForComposer();
    const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
    timeline.scrollTop = 0;

    fireEvent.scroll(timeline);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "messages/read-month",
        month: "2026-07",
      }),
    );
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(timeline.scrollTop).toBe(0);
  });

  it("keeps message actions available but pauses history loading during synchronization", async () => {
    await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    const monthResponse = await originalImplementation({
      type: "messages/read-current-month",
    });
    let finishSynchronization!: () => void;
    const synchronization = new Promise<typeof monthResponse>((resolve) => {
      finishSynchronization = () => resolve(monthResponse);
    });
    sendMessage.mockImplementation((request: RuntimeRequest) =>
      request.type === "messages/read-current-month"
        ? synchronization
        : originalImplementation(request),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    );

    const conversation = screen.getByRole("region", {
      name: "OneDrop messages",
    });
    await waitFor(() =>
      expect(conversation).toHaveAttribute("aria-busy", "true"),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "More message actions" })[0]!,
    );
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();

    const composer = screen.getByPlaceholderText("Message");
    fireEvent.change(composer, { target: { value: "sent while syncing" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "messages/send-text",
          text: "sent while syncing",
        }),
      ),
    );

    const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);
    expect(sendMessage).not.toHaveBeenCalledWith({
      type: "messages/read-month",
      month: "2026-07",
    });

    finishSynchronization();
    await waitFor(() =>
      expect(conversation).toHaveAttribute("aria-busy", "false"),
    );
  });

  it("does not let a stale synchronization response remove a message sent meanwhile", async () => {
    const composer = await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    const staleResponse = await originalImplementation({
      type: "messages/read-current-month",
    });
    if (
      !staleResponse.ok ||
      staleResponse.type !== "messages/month" ||
      staleResponse.result.state !== "loaded"
    ) {
      throw new Error("Expected the current month fixture to be loaded.");
    }
    const staleResult = staleResponse.result;
    let finishSynchronization!: () => void;
    const synchronization = new Promise<typeof staleResponse>((resolve) => {
      finishSynchronization = () => resolve(staleResponse);
    });
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "messages/read-current-month") {
        return synchronization;
      }
      if (request.type === "messages/send-text") {
        return {
          ok: true,
          type: "messages/month",
          result: {
            ...staleResult,
            messages: [
              ...staleResult.messages,
              createTextMessage(
                request.text,
                new Date(request.createdAt!),
                request.messageId!,
                "01989f5e-7700-7000-8000-000000000099",
              ),
            ],
          },
        };
      }
      return originalImplementation(request);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    );
    fireEvent.change(composer, { target: { value: "survives stale sync" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(await screen.findByText("survives stale sync")).toBeInTheDocument();
    finishSynchronization();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "OneDrop messages" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByText("survives stale sync")).toBeInTheDocument();
  });

  it("does not apply a synchronization response while a text write is active", async () => {
    const composer = await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    const staleResponse = await originalImplementation({
      type: "messages/read-current-month",
    });
    if (
      !staleResponse.ok ||
      staleResponse.type !== "messages/month" ||
      staleResponse.result.state !== "loaded"
    ) {
      throw new Error("Expected the current month fixture to be loaded.");
    }
    const staleResult = staleResponse.result;
    let finishWrite!: () => void;
    const writeResponse = new Promise<RuntimeResponse>((resolve) => {
      finishWrite = () =>
        resolve({
          ok: true,
          type: "messages/month",
          result: {
            ...staleResult,
            messages: [
              ...staleResult.messages,
              createTextMessage(
                "active local write",
                new Date("2026-08-11T00:00:00.000Z"),
                "01989f5e-7700-7000-8000-000000000099",
                "01989f5e-7700-7000-8000-000000000099",
              ),
            ],
          },
        });
    });
    sendMessage.mockImplementation((request: RuntimeRequest) =>
      request.type === "messages/send-text"
        ? writeResponse
        : request.type === "messages/read-current-month"
          ? Promise.resolve(staleResponse)
          : originalImplementation(request),
    );

    fireEvent.change(composer, { target: { value: "active local write" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("active local write")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "OneDrop messages" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByText("active local write")).toBeInTheDocument();

    finishWrite();
    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([request]) => request.type === "messages/send-text",
        ),
      ).toHaveLength(1),
    );
  });

  it("does not let a stale synchronization response restore a deleted message", async () => {
    await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    const staleResponse = await originalImplementation({
      type: "messages/read-current-month",
    });
    let finishSynchronization!: () => void;
    const synchronization = new Promise<typeof staleResponse>((resolve) => {
      finishSynchronization = () => resolve(staleResponse);
    });
    sendMessage.mockImplementation((request: RuntimeRequest) =>
      request.type === "messages/read-current-month"
        ? synchronization
        : originalImplementation(request),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh messages and files" }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "More message actions" })[0]!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "messages/delete",
        messageId: "01989f5e-7700-7000-8000-000000000001",
        month: "2026-08",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("from this Edge")).not.toBeInTheDocument(),
    );

    finishSynchronization();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "OneDrop messages" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.queryByText("from this Edge")).not.toBeInTheDocument();
  });

  it("queues another optimistic text while the current text write is serialized", async () => {
    const composer = await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    const baseResponse = await originalImplementation({
      type: "messages/read-current-month",
    });
    if (
      !baseResponse.ok ||
      baseResponse.type !== "messages/month" ||
      baseResponse.result.state !== "loaded"
    ) {
      throw new Error("Expected the current month fixture to be loaded.");
    }
    const baseResult = baseResponse.result;
    let finishFirstWrite!: () => void;
    let sentMessages = [...baseResult.messages];
    const firstWrite = new Promise<RuntimeResponse>((resolve) => {
      finishFirstWrite = () =>
        resolve({
          ok: true,
          type: "messages/month",
          result: { ...baseResult, messages: sentMessages },
        });
    });
    let textWriteCount = 0;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "messages/send-text") {
        return originalImplementation(request);
      }
      textWriteCount += 1;
      sentMessages = [
        ...sentMessages,
        createTextMessage(
          request.text,
          new Date(request.createdAt!),
          request.messageId!,
          "01989f5e-7700-7000-8000-000000000099",
        ),
      ];
      if (textWriteCount === 1) return firstWrite;
      return {
        ok: true,
        type: "messages/month",
        result: { ...baseResult, messages: sentMessages },
      };
    });

    fireEvent.change(composer, { target: { value: "queued first" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(textWriteCount).toBe(1));

    fireEvent.change(composer, { target: { value: "queued second" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(textWriteCount).toBe(1);
    expect(await screen.findByText("queued second")).toBeInTheDocument();
    expect(composer).toHaveValue("");

    finishFirstWrite();
    await waitFor(() => expect(textWriteCount).toBe(2));
  });

  it("continues the text write queue after an earlier write fails", async () => {
    const composer = await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    let rejectFirstWrite!: () => void;
    const firstWrite = new Promise<RuntimeResponse>((_resolve, reject) => {
      rejectFirstWrite = () => reject(new Error("temporary write failure"));
    });
    let textWriteCount = 0;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "messages/send-text") {
        return originalImplementation(request);
      }
      textWriteCount += 1;
      if (textWriteCount === 1) return firstWrite;
      return originalImplementation(request);
    });

    fireEvent.change(composer, { target: { value: "fails first" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("fails first")).toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "continues second" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("continues second")).toBeInTheDocument();
    expect(textWriteCount).toBe(1);

    rejectFirstWrite();
    await waitFor(() => expect(textWriteCount).toBe(2));
  });

  it("does not send Enter while an IME composition is active", async () => {
    const composer = await screenForComposer();
    fireEvent.change(composer, { target: { value: "中文" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });

    expect(sendMessage).not.toHaveBeenCalledWith({
      type: "messages/send-text",
      text: "中文",
    });
  });

  it("uploads a file dropped onto the desktop side panel", async () => {
    await screenForComposer();
    const originalImplementation = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "files/send") return originalImplementation(request);
      const month = await originalImplementation({
        type: "messages/read-current-month",
      });
      if (!month.ok || month.type !== "messages/month") return month;
      return {
        ok: true,
        type: "files/transfer",
        transfer: { state: "sent", result: month.result },
      };
    });
    const shell = document.querySelector<HTMLElement>(".shell")!;
    const file = new File(["dropped content"], "dropped.txt", {
      type: "text/plain",
    });
    const dataTransfer = {
      types: ["Files"],
      files: [file],
      dropEffect: "none",
    };

    fireEvent.dragEnter(shell, { dataTransfer });
    expect(screen.getByText("Drop to send")).toBeInTheDocument();
    fireEvent.drop(shell, { dataTransfer });

    expect(screen.queryByText("Drop to send")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "files/send",
          file: expect.objectContaining({ name: "dropped.txt" }),
        }),
      ),
    );
  });
});

describe("message presentation groups", () => {
  it("groups consecutive messages from one device within five minutes", () => {
    const deviceId = "01989f5e-7700-7000-8000-000000000099";
    const messages = [
      createTextMessage(
        "one",
        new Date("2026-08-03T00:00:00.000Z"),
        "01989f5e-7700-7000-8000-000000000001",
        deviceId,
      ),
      createTextMessage(
        "two",
        new Date("2026-08-03T00:04:00.000Z"),
        "01989f5e-7700-7000-8000-000000000002",
        deviceId,
      ),
      createTextMessage(
        "three",
        new Date("2026-08-03T00:10:00.000Z"),
        "01989f5e-7700-7000-8000-000000000003",
        deviceId,
      ),
    ];

    expect(
      groupMessages(messages, deviceId).map((group) => group.messages),
    ).toEqual([messages.slice(0, 2), messages.slice(2)]);
  });
});

describe("month snapshot ordering", () => {
  it("accepts only the latest read when no write completed meanwhile", () => {
    expect(
      shouldApplyMonthRead({ requestVersion: 2, writeVersion: 4 }, 2, 4),
    ).toBe(true);
    expect(
      shouldApplyMonthRead({ requestVersion: 1, writeVersion: 4 }, 2, 4),
    ).toBe(false);
  });

  it("rejects a read response when a local write completed meanwhile", () => {
    expect(
      shouldApplyMonthRead({ requestVersion: 3, writeVersion: 4 }, 3, 5),
    ).toBe(false);
  });

  it("rejects a read response while a local write is still active", () => {
    expect(
      shouldApplyMonthRead({ requestVersion: 3, writeVersion: 4 }, 3, 4, 1),
    ).toBe(false);
  });
});

describe("floating action menu positioning", () => {
  it("flips horizontally and vertically when the preferred sides overflow", () => {
    expect(
      getFloatingMenuPosition({
        anchor: { top: 4, bottom: 32, left: 4, right: 32 },
        menuHeight: 80,
        menuWidth: 120,
        preferredPlacement: "above",
        preferredSide: "left",
        viewportHeight: 300,
        viewportWidth: 320,
      }),
    ).toEqual({ left: 34, top: 34 });
  });

  it("clamps a menu inside the viewport when neither side fully fits", () => {
    expect(
      getFloatingMenuPosition({
        anchor: { top: 90, bottom: 118, left: 90, right: 118 },
        menuHeight: 260,
        menuWidth: 260,
        preferredPlacement: "below",
        preferredSide: "right",
        viewportHeight: 220,
        viewportWidth: 220,
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});

async function screenForComposer(): Promise<HTMLTextAreaElement> {
  render(<App />);
  return screen.findByPlaceholderText<HTMLTextAreaElement>("Message");
}
