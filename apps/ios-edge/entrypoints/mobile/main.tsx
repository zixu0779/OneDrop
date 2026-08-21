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
