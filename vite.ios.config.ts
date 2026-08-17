import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/ios/web",
  envDir: "../../..",
  envPrefix: ["VITE_", "WXT_"],
  plugins: [react()],
  resolve: {
    alias: {
      "@onedrop/core": resolve("packages/core/src"),
      "@onedrop/onedrive": resolve("packages/onedrive/src"),
      "@onedrop/web-storage": resolve("packages/web-storage/src"),
      "@onedrop/platform": resolve("packages/platform/src"),
      "@onedrop/app-runtime": resolve("packages/app-runtime/src"),
      "@onedrop/ui": resolve("packages/ui/src"),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: "../../../dist/ios",
  },
});
