import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  dev: {
    server: {
      port: 3000,
      strictPort: true,
    },
  },
  manifest: {
    name: "OneDrop",
    description:
      "Share text and files across Edge devices through your OneDrive.",
    version: "0.1.0",
    minimum_chrome_version: "114",
    permissions: [
      "alarms",
      "downloads",
      "downloads.open",
      "identity",
      "sidePanel",
      "storage",
    ],
    host_permissions: [
      "https://graph.microsoft.com/*",
      "https://login.microsoftonline.com/*",
    ],
    action: {
      default_title: "Open OneDrop",
    },
  },
});
