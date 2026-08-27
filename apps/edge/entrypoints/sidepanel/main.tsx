import React from "react";
import ReactDOM from "react-dom/client";

import { browserPlatformBridge } from "@onedrop/platform/platform/browser-platform-bridge";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { App } from "@onedrop/ui/OneDropApp";
import { detectEdgeRuntimePlatform } from "@onedrop/extension-runtime/edge-platform";
import {
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import "@onedrop/ui/styles.css";

async function start(): Promise<void> {
  let operatingSystem: string | undefined;
  try {
    operatingSystem = (await browser.runtime.getPlatformInfo()).os;
  } catch {
    // User-agent detection remains available.
  }
  const platform = detectEdgeRuntimePlatform(
    navigator.userAgent,
    operatingSystem,
  );
  if (platform === "ios") {
    const [{ iosEdgePlatformBridge }, { configureIosEdgeMobileSurface }] =
      await Promise.all([
        import("../../ios-platform-bridge"),
        import("../../ios-mobile-surface"),
        import("@onedrop/ui/mobile.css"),
        import("../ios-mobile/styles.css"),
      ]);
    configureIosEdgeMobileSurface();
    setPlatformBridge(iosEdgePlatformBridge);
  } else {
    setPlatformBridge(browserPlatformBridge);
  }
  const cached = cachedPreferences();
  applyAppearance(cached.appearance.theme, cached.appearance.textSize);

  const root = document.getElementById("root");

  if (!root) {
    throw new Error("OneDrop side panel root was not found.");
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
