import type {
  ArchiveRuntimeEvent,
  FileTransferRuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";

export type PlatformRuntimeEvent =
  | ArchiveRuntimeEvent
  | FileTransferRuntimeEvent
  | {
      type: "files/download-progress";
      driveItemId: string;
      receivedBytes: number;
      totalBytes: number;
    };

export type PlatformDownload = {
  id: number;
  state: "in_progress" | "interrupted" | "complete";
  exists?: boolean;
  filename?: string;
};

export type PlatformCapabilities = {
  showInFolder: boolean;
  saveAs: boolean;
  navigationDownload: boolean;
};

export interface PlatformBridge {
  readonly capabilities: PlatformCapabilities;
  appVersion(): string;
  request(request: RuntimeRequest): Promise<RuntimeResponse>;
  subscribe(listener: (event: PlatformRuntimeEvent) => void): () => void;
  findDownload(downloadId: number): Promise<PlatformDownload | undefined>;
  findAttachmentDownload(
    driveItemId: string,
  ): Promise<PlatformDownload | undefined>;
  openDownload(downloadId: number): Promise<void>;
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
}

let activeBridge: PlatformBridge | undefined;

const defaultBrowserBridge: PlatformBridge = {
  capabilities: {
    showInFolder: true,
    saveAs: true,
    navigationDownload: false,
  },
  appVersion() {
    return browser.runtime.getManifest().version;
  },
  async request(request) {
    return (await browser.runtime.sendMessage(request)) as RuntimeResponse;
  },
  subscribe(listener) {
    if (!browser.runtime.onMessage) return () => undefined;
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  },
  async findDownload(downloadId) {
    const [item] = await browser.downloads.search({ id: downloadId });
    if (!item) return undefined;
    return {
      id: item.id,
      state: item.state,
      ...(item.exists === undefined ? {} : { exists: item.exists }),
      ...(item.filename ? { filename: item.filename } : {}),
    };
  },
  async findAttachmentDownload() {
    return undefined;
  },
  async openDownload(downloadId) {
    await browser.downloads.open(downloadId);
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async copyImage(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "image/png"]: blob }),
    ]);
  },
};

export function setPlatformBridge(bridge: PlatformBridge): void {
  activeBridge = bridge;
}

export function getPlatformBridge(): PlatformBridge {
  return activeBridge ?? defaultBrowserBridge;
}
