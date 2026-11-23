import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { appMetadata } from "@onedrop/core/config/app";
import type { UpdateAsset } from "@onedrop/core/domain/app-update";
import {
  configureUpdates,
  checkUpdates,
} from "@onedrop/app-runtime/features/updates/update-service";
import { nativeDownload } from "./native-download";
const installer = registerPlugin<{
  install(asset: UpdateAsset): Promise<{ message: string }>;
  addListener(
    event: "progress",
    callback: (event: {
      sha256: string;
      received: number;
      total: number;
    }) => void,
  ): Promise<PluginListenerHandle>;
}>("OneDropUpdate");
export function startNativeUpdates() {
  const beta = import.meta.env.VITE_ONEDROP_IOS_BETA_VERSION;
  const android = Capacitor.getPlatform() === "android";
  configureUpdates({
    platform: android ? "android" : "ios",
    channel: beta ? "beta" : "stable",
    version: beta || appMetadata.version,
    ...(android
      ? {
          install: async (
            asset?: UpdateAsset,
            onProgress?: (received: number, total: number) => void,
          ) => {
            if (!asset) throw new Error("Update information is missing.");
            const listener = await installer.addListener(
              "progress",
              (event) => {
                if (event.sha256 === asset.sha256)
                  onProgress?.(event.received, event.total);
              },
            );
            try {
              return (await installer.install(asset)).message;
            } finally {
              await listener.remove();
            }
          },
        }
      : {
          download: async (url: string) => {
            await nativeDownload.openExternal({ url });
          },
        }),
  });
  void checkUpdates();
}
