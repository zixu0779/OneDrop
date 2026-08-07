import {
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
import { createTextMessage } from "../../src/features/messages/create-text-message";

const sendMessage = vi.fn(async (request: { type: string }) => {
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
    default:
      throw new Error("Unexpected request");
  }
});

describe("side panel message composer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    sendMessage.mockClear();
    vi.stubGlobal("browser", { runtime: { sendMessage } });
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
