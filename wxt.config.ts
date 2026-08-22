import { defineConfig } from "wxt";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { appMetadata } from "./packages/core/src/config/app";

const desktopSigningKeyPath = resolve(".keys", "desktop-dev-public.key");
const desktopSigningKey = existsSync(desktopSigningKeyPath)
  ? readFileSync(desktopSigningKeyPath, "utf8").trim()
  : undefined;

export function createDesktopManifest(
  command: "serve" | "build",
  signingKey = desktopSigningKey,
) {
  return {
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
      "sidePanel",
      "storage",
    ],
    host_permissions: [
      "https://graph.microsoft.com/*",
      "https://login.microsoftonline.com/*",
    ],
    action: { default_title: "Open OneDrop" },
    ...(command === "serve" && signingKey ? { key: signingKey } : {}),
  };
}

export default defineConfig({
  srcDir: "apps/desktop-edge",
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
  modules: ["@wxt-dev/module-react"],
  dev: { server: { port: 3000, strictPort: true } },
  manifest: ({ command }) => createDesktopManifest(command),
});
