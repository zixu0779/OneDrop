import { AppLoading } from "@onedrop/ui/LoadingSpinner";
import { initializeExtensionAccount } from "@onedrop/extension-runtime/account-bootstrap";
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

const element = document.getElementById("root");
if (!element) throw new Error("OneDrop root was not found.");
const appRoot = ReactDOM.createRoot(element);
appRoot.render(<AppLoading />);

async function start() {
  await initializeExtensionAccount();
  setPlatformBridge(browserPlatformBridge);
  const cached = cachedPreferences();
  applyAppearance(cached.appearance.theme, cached.appearance.textSize);

  appRoot.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start().catch(() => appRoot.render(<AppLoading failed />));
