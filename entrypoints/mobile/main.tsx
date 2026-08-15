import React from "react";
import ReactDOM from "react-dom/client";

import { browserPlatformBridge } from "../../src/platform/browser-platform-bridge";
import { setPlatformBridge } from "../../src/platform/platform-bridge";
import { App } from "../sidepanel/App";
import {
  applyAppearance,
  cachedPreferences,
} from "../../src/features/settings/settings-cache";
import "../sidepanel/styles.css";
import "./styles.css";

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
