import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import {
  compareVersions,
  selectUpdate,
  validateUpdateAsset,
} from "@onedrop/core/domain/app-update";
const asset = (platform = "ios", channel = "stable", version = "1.2.0") => ({
  platform,
  channel,
  version,
  size: 100,
  sha256: "a".repeat(64),
  url: `https://github.com/zixu0779/OneDrop/releases/download/${channel === "beta" ? "ios-beta-v" : "v"}${version}/OneDrop-${channel === "beta" ? "Beta-" : ""}${version}${platform === "ios" ? ".ipa" : platform === "android" ? "-android.apk" : "-mobile-edge.crx"}`,
});
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ schemaVersion: 1, assets: [asset()] })),
      ),
  );
});
test("numeric versions, platform and channel select independently; missing feed never means latest", () => {
  expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  expect(compareVersions("1.1.0", "1.1.0.0")).toBe(0);
  const feed = {
    schemaVersion: 1,
    assets: [
      asset(),
      asset("ios", "beta", "2.0.0"),
      asset("android", "stable", "3.0.0"),
    ],
  };
  expect(
    selectUpdate(feed, { platform: "ios", channel: "stable", version: "1.1.0" })
      .version,
  ).toBe("1.2.0");
  expect(
    selectUpdate(feed, { platform: "ios", channel: "beta", version: "1.1.1" })
      .version,
  ).toBe("2.0.0");
  expect(() =>
    selectUpdate(
      { schemaVersion: 1, assets: [] },
      { platform: "ios", channel: "stable", version: "1.1.0" },
    ),
  ).toThrow();
  expect(() =>
    validateUpdateAsset({ ...asset(), url: "https://example.org/update.ipa" }),
  ).toThrow();
  expect(() => validateUpdateAsset({ ...asset(), sha256: "bad" })).toThrow();
});
test("local calendar date and atomic claims are installation-scoped across concurrent callers", async () => {
  const { claimUpdateDay, localCalendarDate } =
    await import("@onedrop/app-runtime/features/updates/update-service");
  expect(localCalendarDate(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
  expect(
    (
      await Promise.all([
        claimUpdateDay("ios.stable", "2026-01-01"),
        claimUpdateDay("ios.stable", "2026-01-01"),
      ])
    ).filter(Boolean),
  ).toHaveLength(1);
  expect(await claimUpdateDay("ios.beta", "2026-01-01")).toBe(true);
  expect(await claimUpdateDay("ios.stable", "2026-01-02")).toBe(true);
});
test("automatic checks do not download; manual retries but prevents another automatic check that day", async () => {
  const service =
    await import("@onedrop/app-runtime/features/updates/update-service");
  const download = vi.fn().mockResolvedValue(undefined);
  service.configureUpdates({
    platform: "ios",
    channel: "stable",
    version: "1.1.0",
    download,
  });
  await service.checkUpdates(true);
  await service.checkUpdates();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(download).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    }),
  );
  await service.applyUpdate();
  expect(download).toHaveBeenCalledExactlyOnceWith(asset().url);
});
test("failure remains retryable and cannot report up to date", async () => {
  const service =
    await import("@onedrop/app-runtime/features/updates/update-service");
  service.configureUpdates({
    platform: "ios",
    channel: "stable",
    version: "1.1.0",
  });
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Offline"));
  await service.checkUpdates();
  expect(service.updateState().error).toBe("Offline");
  expect(service.updateState().result).toBeUndefined();
  await service.checkUpdates();
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.checkUpdates(true);
  expect(service.updateState().result?.state).toBe("available");
});
test("cache cannot cross channels and known store updates survive throttling", async () => {
  const service =
    await import("@onedrop/app-runtime/features/updates/update-service");
  localStorage.setItem(
    "onedrop.updates.v1.ios.beta",
    JSON.stringify({
      result: { state: "available", version: "1.2.0", asset: asset() },
    }),
  );
  service.configureUpdates({
    platform: "ios",
    channel: "beta",
    version: "1.1.0",
  });
  expect(service.updateState().result).toBeUndefined();
  service.configureUpdates({
    platform: "desktop-edge",
    channel: "stable",
    version: "1.1.0",
    checkStore: async () => {
      throw new Error("Throttled");
    },
  });
  service.rememberStoreUpdate("1.2.0");
  await service.checkUpdates(true);
  expect(service.updateState()).toMatchObject({
    result: { state: "available", version: "1.2.0" },
    error: "Throttled",
  });
});
test("other windows receive checked results without replacing their own pending action", async () => {
  const service =
    await import("@onedrop/app-runtime/features/updates/update-service");
  service.configureUpdates({
    platform: "ios",
    channel: "stable",
    version: "1.1.0",
  });
  const key = "onedrop.updates.v1.ios.stable";
  localStorage.setItem(
    key,
    JSON.stringify({
      result: { state: "available", version: "1.2.0", asset: asset() },
    }),
  );
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(service.updateState().result?.version).toBe("1.2.0");
});
test("work locking prevents new persistence and refuses an active task", async () => {
  const work =
    await import("@onedrop/app-runtime/features/updates/update-work");
  const finish = work.beginUpdateWork();
  expect(work.lockUpdateWork()).toBe(false);
  finish();
  expect(work.lockUpdateWork()).toBe(true);
  expect(() => work.beginUpdateWork()).toThrow();
  work.unlockUpdateWork();
  expect(() => work.beginUpdateWork()()).not.toThrow();
});

test.each(["before", "during"] as const)(
  "an install cannot overwrite a newer cached check written %s installation",
  async (timing) => {
    const service =
      await import("@onedrop/app-runtime/features/updates/update-service");
    let finish!: (message: string) => void;
    let progress!: (received: number, total: number) => void;
    service.configureUpdates({
      platform: "ios",
      channel: "stable",
      version: "1.1.0",
      install: async (_asset, onProgress) => {
        progress = onProgress!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await service.checkUpdates(true);
    const installing = timing === "during" ? service.applyUpdate() : undefined;
    const key = "onedrop.updates.v1.ios.stable";
    localStorage.setItem(
      key,
      JSON.stringify({
        result: {
          state: "available",
          version: "1.3.0",
          asset: asset("ios", "stable", "1.3.0"),
        },
      }),
    );
    const started = installing ?? service.applyUpdate();
    expect(JSON.parse(localStorage.getItem(key)!).result.version).toBe("1.3.0");
    progress(50, 100);
    expect(JSON.parse(localStorage.getItem(key)!).result.version).toBe("1.3.0");
    finish("Installer opened");
    await started;
    expect(service.updateState().result?.version).toBe("1.3.0");
  },
);
