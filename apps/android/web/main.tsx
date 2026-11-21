import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "@onedrop/ui/OneDropApp";
import "@onedrop/ui/styles.css";
import "@onedrop/ui/mobile.css";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { nativePlatformBridge } from "@onedrop/native-runtime/native-platform-bridge";
import {
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";

document.body.classList.add(
  "mobile-surface",
  "android-surface",
  "native-surface",
);
setPlatformBridge(nativePlatformBridge);
const cached = cachedPreferences();
applyAppearance(cached.appearance.theme, cached.appearance.textSize);

const root = document.getElementById("root");
if (!root) throw new Error("OneDrop Android root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
