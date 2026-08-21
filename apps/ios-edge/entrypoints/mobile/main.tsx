import React from "react";
import ReactDOM from "react-dom/client";

import {
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { App } from "@onedrop/ui/OneDropApp";
import { iosEdgePlatformBridge } from "../../platform-bridge";
import "@onedrop/ui/styles.css";
import "@onedrop/ui/mobile.css";
import "./styles.css";

const viewport = window.visualViewport;
let viewportSyncFrame: number | undefined;

function syncPopupViewport(): void {
  const height = viewport?.height ?? window.innerHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  document.documentElement.style.setProperty(
    "--ios-edge-popup-height",
    `${Math.round(height)}px`,
  );
  document.documentElement.style.setProperty(
    "--ios-edge-popup-offset-top",
    `${Math.round(offsetTop)}px`,
  );
}

function schedulePopupViewportSync(): void {
  if (viewportSyncFrame !== undefined) return;
  viewportSyncFrame = window.requestAnimationFrame(() => {
    viewportSyncFrame = undefined;
    syncPopupViewport();
  });
}

syncPopupViewport();
viewport?.addEventListener("resize", schedulePopupViewportSync);
viewport?.addEventListener("scroll", schedulePopupViewportSync);
window.addEventListener("resize", schedulePopupViewportSync);
window.addEventListener("pageshow", schedulePopupViewportSync);

setPlatformBridge(iosEdgePlatformBridge);
const cached = cachedPreferences();
applyAppearance(cached.appearance.theme, cached.appearance.textSize);

const root = document.getElementById("root");
if (!root) throw new Error("OneDrop iOS Edge popup root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
