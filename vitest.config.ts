import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
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
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
