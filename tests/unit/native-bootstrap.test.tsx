import { beforeEach, expect, test, vi } from "vitest";
const s = vi.hoisted(() => ({
  reset: vi.fn(),
  status: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: s.render }) },
}));
vi.mock("@onedrop/ui/OneDropApp", () => ({ App: () => null }));
vi.mock("@onedrop/native-runtime/native-platform-bridge", () => ({
  resumeNativeDownloads: vi.fn(),
}));
vi.mock("@onedrop/native-runtime/native-auth", () => ({
  nativeAuthPlugin: { resetAuthorization: s.reset, status: s.status },
}));
vi.mock("@onedrop/native-runtime/account-session", () => ({
  initializeAccountSession: s.initialize,
}));
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/database", () => ({
  configureNativeDatabase: vi.fn(),
}));
vi.mock("@onedrop/app-runtime/features/settings/settings-cache", () => ({
  configureSettingsScope: vi.fn(),
  applyAppearance: vi.fn(),
  cachedPreferences: () => ({ appearance: {} }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  s.status.mockResolvedValue({ state: "signed-in", accountKey: "A" });
  s.initialize.mockResolvedValue("A");
});
test("a remounted WebView clears orphan authorization before binding the saved account", async () => {
  let finish!: () => void;
  s.reset.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const { mountNativeApp } = await import("@onedrop/native-runtime/NativeApp");
  const mounting = mountNativeApp(document.createElement("div"));
  expect(s.reset).toHaveBeenCalledOnce();
  expect(s.status).not.toHaveBeenCalled();
  finish();
  await mounting;
  expect(s.status).toHaveBeenCalledOnce();
  expect(s.initialize).toHaveBeenCalledWith("A");
});
test("failed orphan cleanup cannot proceed to another authorization or bind an account", async () => {
  s.reset.mockRejectedValue(new Error("native unavailable"));
  const { mountNativeApp } = await import("@onedrop/native-runtime/NativeApp");
  await mountNativeApp(document.createElement("div"));
  expect(s.status).not.toHaveBeenCalled();
  expect(s.initialize).not.toHaveBeenCalled();
});
