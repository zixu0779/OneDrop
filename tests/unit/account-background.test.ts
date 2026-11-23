import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  activeKey: "A",
  read: vi.fn(),
  pause: vi.fn(),
  configure: vi.fn(),
  remove: vi.fn(),
  updateCheck: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("@onedrop/core/domain/local-account", () => ({
  accountStorageScope: async (key: string) => key,
}));
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/account-data", () => ({
  pauseAccountTransfers: async () => undefined,
}));
vi.mock("@onedrop/app-runtime/features/auth/auth-service", () => ({
  listAccounts: async () => ({ activeKey: state.activeKey, accounts: [] }),
  getAuthStatus: async () => ({
    state: "signed-in",
    account: {},
    redirectUri: "test",
    expiresAt: "test",
  }),
  getCurrentAccessToken: async () => state.activeKey,
  switchAccount: async (key: string) => {
    state.activeKey = key;
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  removeAccount: state.remove,
  resumePendingTabAuthorization: async () => undefined,
  hasPendingAuthorizationCallback: async () => false,
}));
vi.mock("@onedrop/app-runtime/features/device/device-service", () => ({
  getOrCreateDeviceId: async () => "device",
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/settings", () => ({
  readSettingsWithAccessToken: state.read,
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/archive-scheduler", () => ({
  pauseArchiveTasks: state.pause,
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup", () => ({
  pauseAttachmentCleanup: state.pause,
}));
let closeDatabase = () => {};
let request: (message: Record<string, unknown>) => Promise<unknown>;
let connectUpdateView: (port: unknown) => void;
beforeEach(async () => {
  closeDatabase();
  vi.resetModules();
  vi.clearAllMocks();
  state.activeKey = "A";
  state.pause.mockResolvedValue(undefined);
  state.remove.mockResolvedValue(undefined);
  vi.stubGlobal("defineBackground", (start: () => void) => start());
  vi.stubGlobal("browser", {
    runtime: {
      getPlatformInfo: async () => ({ os: "mac" }),
      getManifest: () => ({
        version: "1.1.0",
        update_url: "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
      }),
      requestUpdateCheck: state.updateCheck,
      reload: state.reload,
      onConnect: {
        addListener: (handler: typeof connectUpdateView) => {
          connectUpdateView = handler;
        },
      },
      onUpdateAvailable: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (handler: typeof request) => {
          request = handler;
        },
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    action: { onClicked: { addListener: vi.fn() }, setPopup: vi.fn() },
    sidePanel: { setPanelBehavior: vi.fn() },
    storage: {
      local: { get: async () => ({}), set: vi.fn(), remove: vi.fn() },
    },
  });
  await import("@onedrop/extension-runtime/background");
  await request({ type: "accounts/list" });
  const database =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  closeDatabase = () => database.oneDropDatabase.close();
});
test("ordinary status reads do not pause active work", async () => {
  await request({ type: "auth/status", accountScope: "A" });
  expect(state.pause).not.toHaveBeenCalled();
});
test("switch drains old owner work before replacing database/token and rejects stale windows", async () => {
  let finish!: (value: object) => void;
  state.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = request({
    type: "settings/read",
    accountScope: "A",
    platform: "mac",
    deviceName: "test",
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const switching = request({
    type: "accounts/switch",
    accountScope: "A",
    accountKey: "B",
  });
  await Promise.resolve();
  expect(state.activeKey).toBe("A");
  finish({ owner: "A" });
  await old;
  await switching;
  expect(state.activeKey).toBe("B");
  expect(
    (await import("@onedrop/web-storage/infrastructure/indexed-db/database"))
      .oneDropDatabase.name,
  ).toBe("OneDrop.edge.B");
  expect(
    await request({ type: "settings/read", accountScope: "A" }),
  ).toMatchObject({ ok: false });
  expect(state.read).toHaveBeenCalledTimes(1);
});
test("inactive removal locks account mutations without pausing active business", async () => {
  let finish!: () => void;
  state.remove.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const removing = request({
    type: "accounts/remove",
    accountScope: "A",
    accountKey: "B",
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(
    await request({
      type: "accounts/switch",
      accountScope: "A",
      accountKey: "B",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await request({ type: "auth/status", accountScope: "A" }),
  ).toMatchObject({ ok: true });
  expect(state.pause).not.toHaveBeenCalled();
  finish();
  await removing;
  expect(state.activeKey).toBe("A");
});

test("queued text rejected by a real switch gate is persisted as paused in A before switching back", async () => {
  const database =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  const { persistPausedResponse } =
    await import("@onedrop/app-runtime/features/auth/account-work");
  const id = "queued-text";
  await database.oneDropDatabase.pendingTexts.put({
    id,
    text: "queued",
    createdAt: "2026-07-10T00:00:00Z",
    status: "sending",
  });
  let finish!: (value: object) => void;
  state.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const running = request({
    type: "settings/read",
    accountScope: "A",
    platform: "mac",
    deviceName: "test",
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const switching = request({
    type: "accounts/switch",
    accountScope: "A",
    accountKey: "B",
  });
  await Promise.resolve();
  await Promise.resolve();
  const command = {
    type: "messages/send-text" as const,
    messageId: id,
    text: "queued",
    createdAt: "2026-07-10T00:00:00Z",
  };
  const response = (await request({
    ...command,
    accountScope: "A",
  })) as import("@onedrop/core/contracts/runtime-messages").RuntimeResponse;
  expect(response).toMatchObject({ ok: false, accountPaused: true });
  await persistPausedResponse(command, response);
  finish({});
  await running;
  await switching;
  expect(await database.oneDropDatabase.pendingTexts.get(id)).toBeUndefined();
  await request({
    type: "accounts/switch",
    accountScope: "B",
    accountKey: "A",
  });
  expect(await database.oneDropDatabase.pendingTexts.get(id)).toMatchObject({
    text: "queued",
    pausedForAccountChange: true,
  });
});

test("forgetting inactive credentials preserves its local draft, file, downloads and scoped storage", async () => {
  const { OneDropDatabase } =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  const db = new OneDropDatabase("OneDrop.edge.B");
  await db.settings.put({ key: "composer-draft", value: "keep draft" });
  await db.pendingTransfers.put({
    id: "kept-file",
    createdAt: "2026-11-22",
    name: "keep.txt",
    mimeType: "text/plain",
    size: 4,
    lastModified: 0,
    blob: new NodeBlob(["keep"]) as unknown as Blob,
    isImage: false,
    status: "upload-failed",
  });
  await db.downloads.put({
    driveItemId: "kept-download",
    downloadId: 1,
    cloudName: "keep.txt",
    createdAt: "now",
  });
  localStorage.setItem("onedrop.edge.B.draft", "keep draft");
  state.remove.mockResolvedValue(undefined);
  expect(
    await request({
      type: "accounts/remove",
      accountScope: "A",
      accountKey: "B",
    }),
  ).toMatchObject({ ok: true });
  expect((await db.settings.get("composer-draft"))?.value).toBe("keep draft");
  expect((await db.pendingTransfers.get("kept-file"))?.blob.size).toBe(4);
  expect(await db.downloads.get("kept-download")).toBeDefined();
  expect(localStorage.getItem("onedrop.edge.B.draft")).toBe("keep draft");
  expect(browser.storage.local.remove).not.toHaveBeenCalled();
  expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "accounts/removed" }),
  );
  expect(state.activeKey).toBe("A");
  expect(state.pause).not.toHaveBeenCalled();
  db.close();
});
test("public remove rejects the active account without interrupting work", async () => {
  expect(
    await request({
      type: "accounts/remove",
      accountScope: "A",
      accountKey: "A",
    }),
  ).toMatchObject({ ok: false });
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.pause).not.toHaveBeenCalled();
});

function updateView(idle: boolean | null = true) {
  const listeners = new Set<(message: unknown) => void>();
  const sent: Array<{ type: string; id?: string }> = [];
  const port = {
    name: "onedrop-updates",
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: (fn: (message: unknown) => void) => listeners.delete(fn),
    },
    onDisconnect: { addListener: vi.fn() },
    postMessage: (message: { type: string; id?: string }) => {
      sent.push(message);
      if (message.type === "lock" && idle !== null)
        for (const fn of listeners) fn({ id: message.id, idle });
    },
  };
  connectUpdateView(port);
  return {
    sent,
    respond: (idle: boolean) => {
      for (const fn of listeners)
        fn({ id: sent.find((message) => message.type === "lock")?.id, idle });
    },
  };
}
async function preparedUpdate() {
  const { oneDropDatabase } =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  await oneDropDatabase.pendingTexts.clear();
  await oneDropDatabase.pendingTransfers.clear();
  state.updateCheck.mockResolvedValue({
    status: "update_available",
    version: "1.2.0",
  });
  expect(await request({ type: "updates/check" })).toMatchObject({
    ok: true,
    result: { state: "available", version: "1.2.0" },
  });
}
test("desktop store throttling is not current and a known prepared update survives no_update", async () => {
  state.updateCheck.mockResolvedValue({ status: "throttled" });
  expect(await request({ type: "updates/check" })).toMatchObject({ ok: false });
  await preparedUpdate();
  state.updateCheck.mockResolvedValue({ status: "no_update" });
  expect(await request({ type: "updates/check" })).toMatchObject({
    ok: true,
    result: { state: "available", version: "1.2.0" },
  });
});
test("desktop Install waits for every window and unlocks all after a busy response", async () => {
  await preparedUpdate();
  const busy = updateView(false),
    late = updateView(null);
  const install = request({ type: "updates/install" });
  await vi.waitFor(() =>
    expect(late.sent.some((message) => message.type === "lock")).toBe(true),
  );
  expect(busy.sent.some((message) => message.type === "unlock")).toBe(false);
  expect(state.reload).not.toHaveBeenCalled();
  expect(
    await request({
      type: "messages/send-text",
      text: "keep",
      messageId: "new",
      accountScope: "A",
    }),
  ).toMatchObject({ ok: false, accountPaused: false });
  late.respond(true);
  expect(await install).toMatchObject({ ok: false });
  expect(busy.sent.at(-1)?.type).toBe("unlock");
  expect(late.sent.at(-1)?.type).toBe("unlock");
});
test("desktop Install drains maintenance before reload and rejects a newly opened window", async () => {
  await preparedUpdate();
  updateView();
  // Each maintenance drain needs its own resolver.
  const finishes: Array<() => void> = [];
  state.pause.mockImplementation(
    () => new Promise<void>((resolve) => finishes.push(resolve)),
  );
  const install = request({ type: "updates/install" });
  await vi.waitFor(() => expect(finishes).toHaveLength(2));
  expect(state.reload).not.toHaveBeenCalled();
  updateView();
  finishes.forEach((resolve) => resolve());
  expect(await install).toMatchObject({ ok: false });
  expect(state.reload).not.toHaveBeenCalled();
  state.pause.mockResolvedValue(undefined);
  expect(await request({ type: "updates/install" })).toMatchObject({
    ok: true,
  });
  expect(state.reload).toHaveBeenCalledTimes(1);
});
