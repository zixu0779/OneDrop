import { startNativeUpdates } from "./native-updates";
import { AppLoading } from "@onedrop/ui/LoadingSpinner";
import { resumeNativeDownloads } from "./native-platform-bridge";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@onedrop/ui/OneDropApp";
import { configureNativeDatabase } from "@onedrop/web-storage/infrastructure/indexed-db/database";
import {
  configureSettingsScope,
  applyAppearance,
  cachedPreferences,
} from "@onedrop/app-runtime/features/settings/settings-cache";
import { initializeAccountSession } from "./account-session";
import { nativeAuthPlugin } from "./native-auth";

export async function mountNativeApp(element: HTMLElement): Promise<void> {
  const root = ReactDOM.createRoot(element);
  root.render(<AppLoading />);
  startNativeUpdates();
  try {
    await nativeAuthPlugin.resetAuthorization();
    const status = await nativeAuthPlugin.status();
    if (status.state === "signed-in" && !status.accountKey)
      throw new Error("Account identity is unavailable.");
    const scope = await initializeAccountSession(
      status.state === "signed-in" ? status.accountKey : undefined,
    );
    configureNativeDatabase(scope);
    configureSettingsScope(scope);
    const cached = cachedPreferences();
    applyAppearance(cached.appearance.theme, cached.appearance.textSize);
    if (status.state === "signed-in") void resumeNativeDownloads();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch {
    root.render(
      <main>
        <p>
          OneDrop could not verify your Microsoft account. Local data has been
          kept.
        </p>
        <button onClick={() => window.location.reload()}>Try again</button>
      </main>,
    );
  }
}
