import { describe, expect, it } from "vitest";

import {
  accountSettingsSchema,
  defaultAccountSettings,
  defaultDevicePreferences,
  devicePreferencesSchema,
} from "../../src/domain/settings";
import { messageTombstoneSchema } from "../../src/domain/tombstone";
import { applyAppearance } from "../../src/features/settings/settings-cache";

describe("settings documents", () => {
  it("can switch light, dark, and system repeatedly in one session", () => {
    const style = document.createElement("style");
    style.textContent =
      "@media (prefers-color-scheme: dark) { .theme-probe { color: white; } }";
    document.head.append(style);
    const media = style.sheet?.cssRules[0];
    if (!(media instanceof CSSMediaRule)) return;

    applyAppearance("light", "default");
    expect(media.media.mediaText).toBe("not all");
    applyAppearance("dark", "default");
    expect(
      document.getElementById("onedrop-forced-dark-theme")?.textContent,
    ).toContain(".theme-probe");
    applyAppearance("system", "default");
    expect(media.media.mediaText).toContain("prefers-color-scheme: dark");
    expect(document.getElementById("onedrop-forced-dark-theme")).toBeNull();
    style.remove();
  });

  it("uses the approved account and device defaults", () => {
    expect(
      defaultAccountSettings(new Date("2026-08-15T00:00:00.000Z")),
    ).toEqual({
      schemaVersion: 1,
      recycleBin: {
        mode: "retention",
        retention: 10,
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    expect(defaultDevicePreferences()).toMatchObject({
      appearance: { theme: "system", textSize: "default" },
      messages: {
        autoScrollForNewMessages: true,
        detectLinks: true,
        enterToSend: true,
      },
      sync: { mode: "normal" },
    });
  });

  it("accepts every exposed recycle and text-size option", () => {
    for (const retention of [3, 7, 10, 30, "forever"] as const) {
      expect(
        accountSettingsSchema.safeParse({
          schemaVersion: 1,
          recycleBin: {
            mode: "retention",
            retention,
            updatedAt: "2026-08-15T00:00:00.000Z",
          },
        }).success,
      ).toBe(true);
    }
    for (const textSize of [
      "extra-small",
      "small",
      "default",
      "large",
      "extra-large",
    ] as const) {
      expect(
        devicePreferencesSchema.safeParse({
          ...defaultDevicePreferences(),
          appearance: { theme: "system", textSize },
        }).success,
      ).toBe(true);
    }
  });

  it("keeps old tombstones readable while recording new recovery policies", () => {
    const base = {
      schemaVersion: 1 as const,
      messageId: "a631bff9-bd21-416d-9acf-9a3d18dcd36d",
      originalMonth: "2026-08",
      deletedAt: "2026-08-15T00:00:00.000Z",
    };
    expect(messageTombstoneSchema.safeParse(base).success).toBe(true);
    expect(
      messageTombstoneSchema.safeParse({
        ...base,
        recovery: { mode: "disabled" },
      }).success,
    ).toBe(true);
    expect(
      messageTombstoneSchema.safeParse({
        ...base,
        recovery: { mode: "retention", retention: "forever" },
      }).success,
    ).toBe(true);
  });
});
