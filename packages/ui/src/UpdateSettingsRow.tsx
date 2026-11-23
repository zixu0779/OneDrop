import { useSyncExternalStore } from "react";
import {
  applyUpdate,
  checkUpdates,
  subscribeUpdates,
  updateAdapter,
  updateState,
} from "@onedrop/app-runtime/features/updates/update-service";
import { LoadingSpinner } from "./LoadingSpinner";
export function UpdateSettingsRow() {
  const state = useSyncExternalStore(
    subscribeUpdates,
    updateState,
    updateState,
  );
  let platform: string;
  try {
    platform = updateAdapter().platform;
  } catch {
    return null;
  }
  const available = state.result?.state === "available";
  const installing = platform === "android" || platform === "desktop-edge";
  return (
    <div className="settings-update">
      <div className="settings-about">
        <button
          type="button"
          onClick={() => void checkUpdates(true)}
          disabled={!!state.busy}
          aria-busy={state.busy === "check"}
        >
          Check for updates
        </button>
        <span className="settings-update-result">
          {state.busy && <LoadingSpinner />}
          {state.busy === "check"
            ? "Checking…"
            : available
              ? `v${state.result?.version}`
              : state.error
                ? "Check failed"
                : state.result?.state === "current"
                  ? "Up to date"
                  : "Not checked"}
          {available && (
            <button
              type="button"
              disabled={!!state.busy}
              aria-busy={state.busy === "install"}
              onClick={() => void applyUpdate()}
            >
              {installing ? "Install" : "Download"}
            </button>
          )}
        </span>
      </div>
      {platform === "desktop-edge" && (
        <p>Edge also updates store extensions automatically.</p>
      )}
      {available && platform === "ios" && (
        <p>
          Refresh the OneDrop source in LiveContainer to update, or choose
          Download to get the IPA and install it manually.
        </p>
      )}
      {available && platform === "mobile-edge" && (
        <p>Download the CRX, then import it manually in Edge.</p>
      )}
      {state.progress !== undefined && (
        <p role="status">Downloading update… {state.progress}%</p>
      )}
      {state.message && <p role="status">{state.message}</p>}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}
