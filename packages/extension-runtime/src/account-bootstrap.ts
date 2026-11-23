import { pauseLocalAccountWork } from "@onedrop/app-runtime/features/auth/account-work";
import { accountStorageScope } from "@onedrop/core/domain/local-account";
import { configureExtensionDatabase } from "@onedrop/web-storage/infrastructure/indexed-db/database";
import { configureSettingsScope } from "@onedrop/app-runtime/features/settings/settings-cache";
import {
  closeAccountContext,
  configureAccountContext,
  currentAccountScope,
} from "@onedrop/app-runtime/features/auth/account-context";
import type { RuntimeResponse } from "@onedrop/core/contracts/runtime-messages";

export async function initializeExtensionAccount(): Promise<void> {
  // Install before reading the active identity so a simultaneous window switch cannot be missed.
  let changed = false;
  browser.runtime.onMessage.addListener(
    (event: { type?: string; accountScope?: string }) => {
      if (
        event.type === "accounts/resume" &&
        event.accountScope === currentAccountScope()
      ) {
        window.dispatchEvent(new Event("onedrop-account-work-resume"));
        return;
      }
      if (event.type === "accounts/updated") {
        window.dispatchEvent(new Event("onedrop-accounts-updated"));
        return;
      }
      if (event.type !== "accounts/changed") return;
      changed = true;
      closeAccountContext();
      void pauseLocalAccountWork().finally(() => window.location.reload());
    },
  );
  const response = (await browser.runtime.sendMessage({
    type: "accounts/list",
  })) as RuntimeResponse;
  if (!response.ok || response.type !== "accounts/list")
    throw new Error("The account list could not be read.");
  const key = response.accounts.activeKey;
  const scope = key ? await accountStorageScope(key) : "signed-out";
  if (changed) return new Promise(() => {});
  configureAccountContext(scope);
  configureExtensionDatabase(scope);
  configureSettingsScope(scope, "edge");
  // Reconcile a worker restart or a suspended mobile popup on return.
  window.addEventListener("focus", () => {
    void browser.runtime
      .sendMessage({ type: "accounts/list" })
      .then(async (next: RuntimeResponse) => {
        if (!next.ok || next.type !== "accounts/list") return;
        const key = next.accounts.activeKey;
        const scope = key ? await accountStorageScope(key) : "signed-out";
        if (scope !== currentAccountScope()) {
          closeAccountContext();
          void pauseLocalAccountWork().finally(() => window.location.reload());
        }
      });
  });
}
