import { defineConfig } from "wxt";
import { resolve } from "node:path";

import { appMetadata } from "./packages/core/src/config/app";

export default defineConfig({
  srcDir: "apps/ios-edge",
  vite: () => ({
    resolve: {
      alias: {
        "@onedrop/core": resolve("packages/core/src"),
        "@onedrop/onedrive": resolve("packages/onedrive/src"),
        "@onedrop/web-storage": resolve("packages/web-storage/src"),
        "@onedrop/platform": resolve("packages/platform/src"),
        "@onedrop/app-runtime": resolve("packages/app-runtime/src"),
        "@onedrop/ui": resolve("packages/ui/src"),
        "@onedrop/extension-runtime": resolve("packages/extension-runtime/src"),
      },
    },
  }),
  outDir: ".output/edge-ios",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "OneDrop",
    description:
      "Share text and files across Edge devices through your OneDrive.",
    version: appMetadata.version,
    minimum_chrome_version: "114",
    permissions: ["alarms", "identity", "storage", "tabs"],
    host_permissions: [
      "https://graph.microsoft.com/*",
      "https://login.microsoftonline.com/*",
      "https://*.files.1drv.com/*",
      "https://*.sharepoint.com/*",
    ],
    action: {
      default_title: "Open OneDrop",
      default_popup: "mobile.html",
    },
  },
});
