import {
  assertAccountContext,
  currentAccountScope,
} from "@onedrop/app-runtime/features/auth/account-context";
import type {
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import type {
  PlatformBridge,
  PlatformDownload,
  PlatformRuntimeEvent,
} from "./platform-bridge";

export const browserPlatformBridge: PlatformBridge = {
  capabilities: {
    showInFolder: !document.body.classList.contains("mobile-surface"),
    saveAs: !document.body.classList.contains("mobile-surface"),
    navigationDownload: document.body.classList.contains("mobile-surface"),
    systemFileShare: false,
  },

  appVersion(): string {
    return browser.runtime.getManifest().version;
  },

  async request(request: RuntimeRequest): Promise<RuntimeResponse> {
    assertAccountContext();
    const scope = currentAccountScope();
    const response = await browser.runtime.sendMessage({
      ...request,
      accountScope: scope,
    });
    assertAccountContext(scope);
    return response as RuntimeResponse;
  },

  subscribe(listener: (event: PlatformRuntimeEvent) => void): () => void {
    const scopedListener = (
      event: Parameters<typeof listener>[0] & { accountScope?: string },
    ) => {
      try {
        assertAccountContext();
      } catch {
        return;
      }
      if (event.accountScope === currentAccountScope()) listener(event);
    };
    browser.runtime.onMessage.addListener(scopedListener);
    return () => browser.runtime.onMessage.removeListener(scopedListener);
  },

  async findDownload(
    downloadId: number,
  ): Promise<PlatformDownload | undefined> {
    const scope = currentAccountScope();
    assertAccountContext(scope);
    const [item] = await browser.downloads.search({ id: downloadId });
    assertAccountContext(scope);
    if (!item) return undefined;
    return {
      id: item.id,
      state: item.state,
      ...(item.exists === undefined ? {} : { exists: item.exists }),
      ...(item.filename ? { filename: item.filename } : {}),
    };
  },

  async findAttachmentDownload(): Promise<undefined> {
    return undefined;
  },

  async openDownload(downloadId: number): Promise<void> {
    assertAccountContext();
    await browser.downloads.open(downloadId);
  },

  async getPreparedAttachment(): Promise<undefined> {
    return undefined;
  },

  async prepareAttachment(): Promise<never> {
    throw new Error("System file sharing is unavailable on this platform.");
  },

  async shareAttachment(): Promise<never> {
    throw new Error("System file sharing is unavailable on this platform.");
  },

  async copyText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  },

  async copyImage(dataUrl: string): Promise<void> {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "image/png"]: blob }),
    ]);
  },
};
