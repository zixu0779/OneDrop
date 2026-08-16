import { defineConfig } from "wxt";
import { appMetadata } from "./src/config/app";

export default defineConfig({
  outDir: ".output/edge-android",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "OneDrop",
    description:
      "Share text and files across Edge devices through your OneDrive.",
    version: appMetadata.version,
    minimum_chrome_version: "114",
    permissions: [
      "alarms",
      "downloads",
      "downloads.open",
      "identity",
      "storage",
      "tabs",
    ],
    host_permissions: [
      "https://graph.microsoft.com/*",
      "https://login.microsoftonline.com/*",
      "https://*.files.1drv.com/*",
      "https://*.sharepoint.com/*",
    ],
    action: {
      default_title: "Open OneDrop",
    },
  },
});
