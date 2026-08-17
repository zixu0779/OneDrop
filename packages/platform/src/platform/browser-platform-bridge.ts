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
  },

  appVersion(): string {
    return browser.runtime.getManifest().version;
  },

  async request(request: RuntimeRequest): Promise<RuntimeResponse> {
    return (await browser.runtime.sendMessage(request)) as RuntimeResponse;
  },

  subscribe(listener: (event: PlatformRuntimeEvent) => void): () => void {
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  },

  async findDownload(
    downloadId: number,
  ): Promise<PlatformDownload | undefined> {
    const [item] = await browser.downloads.search({ id: downloadId });
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
    await browser.downloads.open(downloadId);
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
