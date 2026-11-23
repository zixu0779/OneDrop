import {
  lockUpdateWork,
  unlockUpdateWork,
} from "@onedrop/app-runtime/features/updates/update-work";
import {
  configureUpdates,
  checkUpdates,
  rememberStoreUpdate,
} from "@onedrop/app-runtime/features/updates/update-service";
import type { UpdateResult } from "@onedrop/core/domain/app-update";
export function startBrowserUpdates(mobile: boolean) {
  if (!mobile) {
    const connect = () => {
      const port = browser.runtime.connect({ name: "onedrop-updates" });
      port.onMessage.addListener((message) => {
        if (message.type === "lock")
          port.postMessage({ id: message.id, idle: lockUpdateWork() });
        else if (message.type === "unlock") unlockUpdateWork();
      });
      port.onDisconnect.addListener(() => {
        unlockUpdateWork();
        setTimeout(connect, 1000);
      });
    };
    connect();
  }
  configureUpdates({
    platform: mobile ? "mobile-edge" : "desktop-edge",
    channel: "stable",
    version: browser.runtime.getManifest().version,
    ...(mobile
      ? {
          download: async (url: string) => {
            await browser.tabs.create({ url });
          },
        }
      : {
          checkStore: async () => {
            const response = (await browser.runtime.sendMessage({
              type: "updates/check",
            })) as { ok: boolean; error?: string; result: UpdateResult };
            if (!response.ok) throw new Error(response.error);
            return response.result;
          },
          install: async () => {
            const response = (await browser.runtime.sendMessage({
              type: "updates/install",
            })) as { ok: boolean; error?: string };
            if (!response.ok) throw new Error(response.error);
            return "The browser is applying the update.";
          },
        }),
  });
  if (!mobile)
    browser.runtime.onUpdateAvailable?.addListener(({ version }) =>
      rememberStoreUpdate(version),
    );
  void checkUpdates();
}
