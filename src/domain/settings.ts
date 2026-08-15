import { z } from "zod";

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);
export const textSizeSchema = z.enum([
  "extra-small",
  "small",
  "default",
  "large",
  "extra-large",
]);
export const syncModeSchema = z.enum(["normal", "reduced", "manual"]);
export const devicePlatformSchema = z.enum([
  "desktop-edge",
  "android-edge",
  "ios",
]);
export const recycleBinSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled"), updatedAt: z.iso.datetime() }),
  z.object({
    mode: z.literal("retention"),
    retention: z.union([
      z.literal(3),
      z.literal(7),
      z.literal(10),
      z.literal(30),
      z.literal("forever"),
    ]),
    updatedAt: z.iso.datetime(),
  }),
]);

export const accountSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  recycleBin: recycleBinSettingSchema,
});

export const devicePreferencesSchema = z.object({
  appearance: z.object({
    theme: themePreferenceSchema,
    textSize: textSizeSchema,
  }),
  messages: z.object({
    enterToSend: z.boolean(),
    autoScrollForNewMessages: z.boolean(),
    detectLinks: z.boolean(),
  }),
  sync: z.object({ mode: syncModeSchema }),
  previews: z.object({
    loadAutomatically: z.boolean(),
    wifiOnly: z.boolean(),
  }),
  downloads: z.object({
    defaultDestination: z.enum(["downloads", "onedrop-folder"]).optional(),
  }),
});

export const deviceSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.uuid(),
  platform: devicePlatformSchema,
  displayName: z.string().trim().min(1).max(120),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  preferences: devicePreferencesSchema,
});

export type AccountSettings = z.infer<typeof accountSettingsSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type DevicePreferences = z.infer<typeof devicePreferencesSchema>;
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;
export type RecycleBinSetting = z.infer<typeof recycleBinSettingSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type TextSize = z.infer<typeof textSizeSchema>;

export function defaultAccountSettings(now = new Date()): AccountSettings {
  return {
    schemaVersion: 1,
    recycleBin: {
      mode: "retention",
      retention: 10,
      updatedAt: now.toISOString(),
    },
  };
}

export function defaultDevicePreferences(): DevicePreferences {
  return {
    appearance: { theme: "system", textSize: "default" },
    messages: {
      enterToSend: true,
      autoScrollForNewMessages: false,
      detectLinks: true,
    },
    sync: { mode: "normal" },
    previews: { loadAutomatically: true, wifiOnly: false },
    downloads: {},
  };
}

export function defaultDeviceDisplayName(platform: DevicePlatform): string {
  if (platform === "ios") return "iOS";
  if (platform === "android-edge") return "Android";
  return "Desktop";
}
