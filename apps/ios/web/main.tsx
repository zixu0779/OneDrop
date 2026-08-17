import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "@onedrop/ui/OneDropApp";
import "@onedrop/ui/styles.css";
import "@onedrop/ui/mobile.css";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { iosPlatformBridge } from "./ios-platform-bridge";
import {
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import "./styles.css";

document.body.classList.add("mobile-surface", "ios-surface");
setPlatformBridge(iosPlatformBridge);
const cached = cachedPreferences();
applyAppearance(cached.appearance.theme, cached.appearance.textSize);

const root = document.getElementById("root");
if (!root) throw new Error("OneDrop iOS root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
