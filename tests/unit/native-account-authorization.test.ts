import { beforeEach, expect, test, vi } from "vitest";
const s = vi.hoisted(() => ({
  read: vi.fn(),
  archive: vi.fn(),
  cleanup: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios" },
  registerPlugin: () => ({ addListener: async () => ({ remove() {} }) }),
}));
vi.mock("@onedrop/native-runtime/account-session", () => ({
  assertAccountSession() {},
  scopedLocalKey: (k: string) => k,
  unscopedDownloadId: (k: string) => k,
  accountScope: () => "A",
}));
vi.mock("@onedrop/native-runtime/native-auth", () => ({
  nativeAuth: { getAccessToken: async () => ({ accessToken: "synthetic" }) },
  nativeAuthPlugin: {
    prepareSignIn: s.prepare,
    commitSignIn: s.commit,
    discardSignIn: s.discard,
    listAccounts: async () => ({ activeKey: "A", accounts: [] }),
  },
  getNativeAuthConfiguration: () => ({ clientId: "test" }),
  restartNativeAccount: s.restart,
}));
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/account-data", () => ({
  pauseAccountTransfers: async () => {},
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/settings", () => ({
  readSettingsWithAccessToken: s.read,
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/archive-scheduler", () => ({
  pauseArchiveTasks: s.archive,
}));
vi.mock("@onedrop/onedrive/infrastructure/onedrive/attachment-cleanup", () => ({
  pauseAttachmentCleanup: s.cleanup,
}));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  for (const fn of Object.values(s)) fn.mockReset();
  s.archive.mockResolvedValue(undefined);
  s.cleanup.mockResolvedValue(undefined);
  s.discard.mockResolvedValue(undefined);
  s.commit.mockResolvedValue({ state: "signed-in" });
  s.restart.mockResolvedValue(undefined);
});
test("OAuth starts before a pending read drains, but activation waits for all work and authorization", async () => {
  const read = deferred<object>(),
    archive = deferred<void>(),
    cleanup = deferred<void>(),
    auth = deferred<{ candidateId: string }>();
  s.read.mockReturnValue(read.promise);
  s.archive.mockReturnValue(archive.promise);
  s.cleanup.mockReturnValue(cleanup.promise);
  s.prepare.mockReturnValue(auth.promise);
  const { nativePlatformBridge: bridge } =
    await import("@onedrop/native-runtime/native-platform-bridge");
  const active = bridge.request({
    type: "settings/read",
    platform: "ios",
    deviceName: "test",
  });
  await vi.waitFor(() => expect(s.read).toHaveBeenCalled());
  const adding = bridge.request({
    type: "accounts/add",
    reauthenticateKey: "B",
  });
  await vi.waitFor(() => expect(s.prepare).toHaveBeenCalled());
  expect(s.prepare.mock.calls[0][0]).toMatchObject({
    reauthenticateKey: "B",
    attemptId: expect.any(String),
  });
  expect(s.commit).not.toHaveBeenCalled();
  auth.resolve({ candidateId: "candidate" });
  read.resolve({});
  await active;
  archive.resolve();
  await Promise.resolve();
  expect(s.commit).not.toHaveBeenCalled();
  cleanup.resolve();
  await adding;
  expect(s.commit).toHaveBeenCalledExactlyOnceWith({
    candidateId: "candidate",
  });
  expect(s.restart).toHaveBeenCalledTimes(1);
});
test("cancel discards its attempt and keeps management locked until old work settles", async () => {
  const read = deferred<object>(),
    auth = deferred<{ candidateId: string }>();
  s.read.mockReturnValue(read.promise);
  s.prepare.mockReturnValue(auth.promise);
  const { nativePlatformBridge: bridge } =
    await import("@onedrop/native-runtime/native-platform-bridge");
  const active = bridge.request({
    type: "settings/read",
    platform: "ios",
    deviceName: "test",
  });
  await vi.waitFor(() => expect(s.read).toHaveBeenCalled());
  const adding = bridge.request({ type: "accounts/add" });
  auth.reject(new Error("Cancelled"));
  await vi.waitFor(() => expect(s.discard).toHaveBeenCalled());
  expect(await bridge.request({ type: "accounts/add" })).toMatchObject({
    ok: false,
  });
  expect(s.prepare).toHaveBeenCalledTimes(1);
  read.resolve({});
  await active;
  expect(await adding).toMatchObject({ ok: false, error: "Cancelled" });
  expect(s.commit).not.toHaveBeenCalled();
  expect(s.restart).not.toHaveBeenCalled();
  expect(await bridge.request({ type: "accounts/list" })).toMatchObject({
    ok: true,
    accounts: { activeKey: "A" },
  });
});
test("drain failure discards a successful candidate without committing or restarting", async () => {
  s.prepare.mockResolvedValue({ candidateId: "candidate" });
  s.archive.mockRejectedValue(new Error("Drain failed"));
  const { nativePlatformBridge: bridge } =
    await import("@onedrop/native-runtime/native-platform-bridge");
  expect(await bridge.request({ type: "accounts/add" })).toMatchObject({
    ok: false,
    error: "Drain failed",
  });
  expect(s.discard).toHaveBeenCalledTimes(1);
  expect(s.commit).not.toHaveBeenCalled();
  expect(s.restart).not.toHaveBeenCalled();
});
test("commit rejection discards the candidate and retains the old account", async () => {
  s.prepare.mockResolvedValue({ candidateId: "candidate" });
  s.commit.mockRejectedValue(new Error("Identity mismatch"));
  const { nativePlatformBridge: bridge } =
    await import("@onedrop/native-runtime/native-platform-bridge");
  expect(await bridge.request({ type: "accounts/add" })).toMatchObject({
    ok: false,
    error: "Identity mismatch",
  });
  expect(s.discard).toHaveBeenCalledTimes(1);
  expect(s.restart).not.toHaveBeenCalled();
});

test("a late authorization result after drain failure cannot activate an account", async () => {
  const auth = deferred<{ candidateId: string }>();
  s.prepare.mockReturnValue(auth.promise);
  s.archive.mockRejectedValue(new Error("Drain failed"));
  const { nativePlatformBridge: bridge } =
    await import("@onedrop/native-runtime/native-platform-bridge");
  expect(await bridge.request({ type: "accounts/add" })).toMatchObject({
    ok: false,
  });
  auth.resolve({ candidateId: "late" });
  await Promise.resolve();
  expect(s.discard).toHaveBeenCalledTimes(1);
  expect(s.commit).not.toHaveBeenCalled();
});
