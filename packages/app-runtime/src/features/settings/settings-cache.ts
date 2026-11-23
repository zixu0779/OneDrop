import { oneDropDatabase } from "@onedrop/web-storage/infrastructure/indexed-db/database";
import {
  defaultAccountSettings,
  defaultDevicePreferences,
  accountSettingsSchema,
  deviceSettingsSchema,
  type AccountSettings,
  type DeviceSettings,
  type ThemePreference,
  type TextSize,
} from "@onedrop/core/domain/settings";

let storagePrefix = "";
export function configureSettingsScope(
  scope: string,
  platform = "native",
): void {
  if (!localStorage.getItem(APPEARANCE_KEY)) {
    const existing = readCachedDeviceSettings();
    if (existing) saveSharedAppearance(existing.preferences.appearance);
  }
  storagePrefix = `onedrop.${platform}.${scope}.`;
}

const ACCOUNT_KEY = "onedrop.settings.account.v1";
const DEVICE_KEY = "onedrop.settings.current-device.v1";
const trackedDarkMediaRules = new Map<
  CSSMediaRule,
  { media: string; css: string[] }
>();

export function readCachedAccountSettings(): AccountSettings {
  return parse(ACCOUNT_KEY, accountSettingsSchema) ?? defaultAccountSettings();
}

export function readCachedDeviceSettings(): DeviceSettings | undefined {
  return parse(DEVICE_KEY, deviceSettingsSchema);
}

export function cacheSettings(
  account: AccountSettings,
  device: DeviceSettings,
): void {
  localStorage.setItem(storagePrefix + ACCOUNT_KEY, JSON.stringify(account));
  localStorage.setItem(storagePrefix + DEVICE_KEY, JSON.stringify(device));
  const appearance = sharedAppearance(device.preferences.appearance);
  applyAppearance(appearance.theme, appearance.textSize);
}

export function clearCachedSettings(): void {
  localStorage.removeItem(storagePrefix + ACCOUNT_KEY);
  localStorage.removeItem(storagePrefix + DEVICE_KEY);
  const appearance = sharedAppearance(defaultDevicePreferences().appearance);
  applyAppearance(appearance.theme, appearance.textSize);
}

export function applyAppearance(
  theme: ThemePreference,
  textSize: TextSize,
): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.textSize = textSize;
  applyForcedColorScheme(theme);
}

export function cachedPreferences() {
  const preferences =
    readCachedDeviceSettings()?.preferences ?? defaultDevicePreferences();
  return {
    ...preferences,
    appearance: sharedAppearance(preferences.appearance),
  };
}

function parse<T>(
  key: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): T | undefined {
  try {
    const raw = localStorage.getItem(storagePrefix + key);
    if (!raw) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function applyForcedColorScheme(theme: ThemePreference): void {
  document.getElementById("onedrop-forced-dark-theme")?.remove();
  if (typeof CSSMediaRule !== "undefined") {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSMediaRule &&
          rule.conditionText.includes("prefers-color-scheme: dark") &&
          !trackedDarkMediaRules.has(rule)
        ) {
          trackedDarkMediaRules.set(rule, {
            media: rule.media.mediaText,
            css: Array.from(rule.cssRules, (inner) => inner.cssText),
          });
        }
      }
    }
  }
  const darkRules: string[] = [];
  for (const [rule, original] of trackedDarkMediaRules) {
    rule.media.mediaText = theme === "system" ? original.media : "not all";
    if (theme === "dark") darkRules.push(...original.css);
  }
  if (theme === "dark") {
    const style = document.createElement("style");
    style.id = "onedrop-forced-dark-theme";
    style.textContent = darkRules.join("\n");
    document.head.append(style);
  }
  document.documentElement.style.colorScheme =
    theme === "system" ? "light dark" : theme;
}

export function readDraft(): string {
  return localStorage.getItem(storagePrefix + "composer-draft") ?? "";
}
export function saveDraft(value: string): void {
  localStorage.setItem(storagePrefix + "composer-draft", value);
  void oneDropDatabase.settings.put({ key: "composer-draft", value });
}

const APPEARANCE_KEY = "onedrop.device.appearance.v1";
export function saveSharedAppearance(
  appearance: ReturnType<typeof defaultDevicePreferences>["appearance"],
): void {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
}
export function sharedAppearance(
  fallback: ReturnType<typeof defaultDevicePreferences>["appearance"],
) {
  try {
    const saved = defaultDevicePreferencesSchemaAppearance(
      JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null"),
    );
    if (saved) return saved;
  } catch {
    /* Replace invalid device appearance with the current valid value. */
  }
  saveSharedAppearance(fallback);
  return fallback;
}
function defaultDevicePreferencesSchemaAppearance(value: unknown) {
  const preferences = defaultDevicePreferences();
  const result = deviceSettingsSchema.shape.preferences.safeParse({
    ...preferences,
    appearance: value,
  });
  return result.success ? result.data.appearance : undefined;
}
