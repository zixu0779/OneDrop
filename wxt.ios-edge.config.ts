import { defineConfig } from "wxt";
import { resolve } from "node:path";

import { appMetadata } from "./packages/core/src/config/app";

export default defineConfig({
  srcDir: "apps/ios-edge",
  vite: () => ({
    resolve: {
      alias: {
        "@onedrop/core": resolve("packages/core/src"),
      },
    },
  }),
  outDir: ".output/edge-ios",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "OneDrop iOS Edge Preview",
    description: "Verify the OneDrop extension popup in Microsoft Edge on iOS.",
    version: appMetadata.version,
    minimum_chrome_version: "114",
    action: {
      default_title: "Open OneDrop",
      default_popup: "mobile.html",
    },
  },
});
