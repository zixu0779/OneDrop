import {
  assertAccountContext,
  currentAccountScope,
} from "@onedrop/app-runtime/features/auth/account-context";
import type {
  ArchiveRuntimeEvent,
  FileTransferRuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import type { Attachment } from "@onedrop/core/domain/message";

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
  systemFileShare: boolean;
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
  getPreparedAttachment(attachment: Attachment): Promise<File | undefined>;
  prepareAttachment(
    attachment: Attachment,
    onProgress: (receivedBytes: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<File>;
  shareAttachment(file: File): Promise<void>;
  exportLocalFile?(name: string, blob: Blob): Promise<void>;
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
}

let activeBridge: PlatformBridge | undefined;

const defaultBrowserBridge: PlatformBridge = {
  capabilities: {
    showInFolder: true,
    saveAs: true,
    navigationDownload: false,
    systemFileShare: false,
  },
  appVersion() {
    return browser.runtime.getManifest().version;
  },
  async request(request) {
    assertAccountContext();
    const scope = currentAccountScope();
    const response = await browser.runtime.sendMessage({
      ...request,
      accountScope: scope,
    });
    assertAccountContext(scope);
    return response as RuntimeResponse;
  },
  subscribe(listener) {
    if (!browser.runtime.onMessage) return () => undefined;
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
  async findDownload(downloadId) {
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
  async findAttachmentDownload() {
    return undefined;
  },
  async openDownload(downloadId) {
    assertAccountContext();
    await browser.downloads.open(downloadId);
  },
  async getPreparedAttachment() {
    return undefined;
  },
  async prepareAttachment() {
    throw new Error("System file sharing is unavailable on this platform.");
  },
  async shareAttachment() {
    throw new Error("System file sharing is unavailable on this platform.");
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
