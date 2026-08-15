import {
  defaultAccountSettings,
  defaultDevicePreferences,
  accountSettingsSchema,
  deviceSettingsSchema,
  type AccountSettings,
  type DeviceSettings,
  type ThemePreference,
  type TextSize,
} from "../../domain/settings";

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
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  applyAppearance(
    device.preferences.appearance.theme,
    device.preferences.appearance.textSize,
  );
}

export function clearCachedSettings(): void {
  localStorage.removeItem(ACCOUNT_KEY);
  localStorage.removeItem(DEVICE_KEY);
  applyAppearance("system", "default");
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
  return readCachedDeviceSettings()?.preferences ?? defaultDevicePreferences();
}

function parse<T>(
  key: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): T | undefined {
  try {
    const raw = localStorage.getItem(key);
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
