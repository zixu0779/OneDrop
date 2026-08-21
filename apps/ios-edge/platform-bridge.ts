import type { PlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import {
  deleteAttachmentCache,
  getAttachmentCache,
  putAttachmentCache,
} from "@onedrop/web-storage/infrastructure/indexed-db/attachment-cache";

export const iosEdgePlatformBridge: PlatformBridge = {
  capabilities: {
    showInFolder: false,
    saveAs: false,
    navigationDownload: false,
    systemFileShare: true,
  },

  appVersion() {
    return browser.runtime.getManifest().version;
  },

  async request(request) {
    return (await browser.runtime.sendMessage(request)) as Awaited<
      ReturnType<PlatformBridge["request"]>
    >;
  },

  subscribe(listener) {
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  },

  async findDownload() {
    return undefined;
  },

  async findAttachmentDownload() {
    return undefined;
  },

  async openDownload() {
    throw new Error("Managed downloads are unavailable in iOS Edge.");
  },

  async getPreparedAttachment(attachment) {
    const cached = await getAttachmentCache(attachment.driveItemId);
    if (!cached) return undefined;
    if (
      cached.name !== attachment.name ||
      cached.size !== attachment.size ||
      cached.blob.size !== attachment.size
    ) {
      await deleteAttachmentCache(attachment.driveItemId);
      return undefined;
    }
    return new File([cached.blob], cached.name, { type: cached.mimeType });
  },

  async prepareAttachment(attachment, onProgress, signal) {
    const response = await browser.runtime.sendMessage({
      type: "files/get-download-url",
      driveItemId: attachment.driveItemId,
    });
    if (!response.ok || response.type !== "files/download-url") {
      throw new Error(response.error || "OneDrop could not prepare the file.");
    }

    const download = await fetch(response.url, { signal });
    if (!download.ok) {
      throw new Error(`File download failed (${download.status}).`);
    }
    const blob = await readDownload(download, attachment.size, onProgress);
    if (attachment.size > 0 && blob.size !== attachment.size) {
      throw new Error("The downloaded file size did not match OneDrive.");
    }
    await putAttachmentCache({
      driveItemId: attachment.driveItemId,
      name: attachment.name,
      mimeType: attachment.mimeType || blob.type || "application/octet-stream",
      size: blob.size,
      blob,
      cachedAt: new Date().toISOString(),
    });
    return new File([blob], attachment.name, {
      type: attachment.mimeType || blob.type || "application/octet-stream",
    });
  },

  async shareAttachment(file) {
    if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
      throw new Error("iOS Edge cannot share this file type.");
    }
    await navigator.share({ files: [file] });
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

async function readDownload(
  response: Response,
  expectedSize: number,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, expectedSize || blob.size);
    return blob;
  }
  const total = Number(response.headers.get("content-length")) || expectedSize;
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new Uint8Array(value).buffer);
    received += value.byteLength;
    onProgress(received, total);
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
}
