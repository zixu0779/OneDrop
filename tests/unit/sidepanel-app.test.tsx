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

vi.mock(
  "../../src/infrastructure/indexed-db/pending-texts",
  () => pendingTextStore,
);

import { App, groupMessages } from "../../entrypoints/sidepanel/App";
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

const sendMessage = vi.fn(
  async (request: RuntimeRequest): Promise<RuntimeResponse> => {
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
                text: "from another Edge",
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
      default:
        throw new Error("Unexpected request");
    }
  },
);

describe("side panel message composer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    sendMessage.mockClear();
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

  it("warns before manual cleanup and shows its final success result", async () => {
    await screenForComposer();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clean up deleted data" }),
    );

    expect(
      screen.getByText(
        /bypasses the 10-day recovery period and cannot be undone/iu,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));

    expect(
      await screen.findByText(
        "Deleted data cleanup has completed successfully.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 deleted items were permanently cleaned up, including 1 attachment.",
      ),
    ).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "deleted-data/clean-now",
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
      fireEvent.click(
        screen.getByRole("button", { name: "Clean up deleted data" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Clean up" }));

      expect(
        await screen.findByText("Temporary cleanup failure."),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(
        await screen.findByText(
          "Deleted data cleanup has completed successfully.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "1 deleted item was permanently cleaned up, including 0 attachments.",
        ),
      ).toBeInTheDocument();
      expect(attempts).toBe(2);
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
    expect(screen.getByText("from another Edge").closest("li")).not.toHaveClass(
      "message-own",
    );
  });

  it("closes account details when the user clicks outside", async () => {
    await screenForComposer();
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /one@example.com|sycamore|microsoft account/iu,
      }),
    );
    expect(screen.getByText("Add account — coming later")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(
        screen.queryByText("Add account — coming later"),
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
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

  it("blocks message actions and history loading while synchronization runs", async () => {
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
    expect(screen.queryByRole("menuitem", { name: "Copy text" })).toBeNull();

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

  it("does not send Enter while an IME composition is active", async () => {
    const composer = await screenForComposer();
    fireEvent.change(composer, { target: { value: "中文" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });

    expect(sendMessage).not.toHaveBeenCalledWith({
      type: "messages/send-text",
      text: "中文",
    });
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

async function screenForComposer(): Promise<HTMLTextAreaElement> {
  render(<App />);
  return screen.findByPlaceholderText<HTMLTextAreaElement>("Message");
}
