import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "OneDrop",
    description:
      "Share text and files across Edge devices through your OneDrive.",
    version: "0.1.0",
    minimum_chrome_version: "114",
    permissions: ["alarms", "downloads", "identity", "sidePanel", "storage"],
    host_permissions: [
      "https://graph.microsoft.com/*",
      "https://login.microsoftonline.com/*",
    ],
    action: {
      default_title: "Open OneDrop",
    },
  },
});
