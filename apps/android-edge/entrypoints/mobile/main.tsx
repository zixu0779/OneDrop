import React from "react";
import ReactDOM from "react-dom/client";

import { browserPlatformBridge } from "@onedrop/platform/platform/browser-platform-bridge";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { App } from "@onedrop/ui/OneDropApp";
import {
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import "@onedrop/ui/styles.css";
import "@onedrop/ui/mobile.css";

setPlatformBridge(browserPlatformBridge);
const cached = cachedPreferences();
applyAppearance(cached.appearance.theme, cached.appearance.textSize);

const root = document.getElementById("root");

if (!root) {
  throw new Error("OneDrop mobile page root was not found.");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
