import { beforeEach, expect, test } from "vitest";
import {
  cacheSettings,
  cachedPreferences,
  configureSettingsScope,
  saveSharedAppearance,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import {
  defaultAccountSettings,
  defaultDevicePreferences,
  type DeviceSettings,
} from "@onedrop/core/domain/settings";
const device = (theme: "dark" | "light"): DeviceSettings => ({
  schemaVersion: 1,
  deviceId: "01989f5e-7700-7000-8000-000000000099",
  displayName: "test",
  platform: "android",
  createdAt: "2026-11-22T00:00:00Z",
  lastSeenAt: "2026-11-22T00:00:00Z",
  preferences: {
    ...defaultDevicePreferences(),
    appearance: { theme, textSize: "default" },
  },
});
beforeEach(() => localStorage.clear());
test("first device appearance survives another account's cloud settings and later explicit changes", () => {
  configureSettingsScope("A");
  cacheSettings(defaultAccountSettings(), device("dark"));
  configureSettingsScope("B");
  cacheSettings(defaultAccountSettings(), device("light"));
  expect(cachedPreferences().appearance.theme).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  saveSharedAppearance({ theme: "light", textSize: "default" });
  configureSettingsScope("A");
  cacheSettings(defaultAccountSettings(), device("dark"));
  expect(cachedPreferences().appearance.theme).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
});
