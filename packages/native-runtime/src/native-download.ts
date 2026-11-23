import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { assertAccountSession, scopedDownloadId } from "./account-session";

export type NativeDownloadProgress = {
  driveItemId: string;
  receivedBytes: number;
  totalBytes: number;
};

type NativeDownloadPlugin = {
  removeAccount(options: { scope: string }): Promise<void>;
  previousDownloads(): Promise<{ files: { id: string; name: string }[] }>;
  download(options: {
    url: string;
    driveItemId: string;
    fileName: string;
  }): Promise<{ fileName: string }>;
  exportLocal(options: {
    fileName: string;
    base64: string;
    exportId: string;
    offset: number;
    complete: boolean;
  }): Promise<{ fileName: string }>;
  cancel(options: { driveItemId: string }): Promise<void>;
  status(options: { driveItemId: string }): Promise<{
    exists: boolean;
    downloading: boolean;
    fileName?: string;
  }>;
  open(options: { driveItemId: string }): Promise<{ fileName: string }>;
  export(options: { driveItemId: string }): Promise<{ fileName: string }>;
  showInFolder(options: { driveItemId: string }): Promise<{ fileName: string }>;
  openExternal(options: { url: string }): Promise<void>;
  copyText(options: { text: string }): Promise<void>;
  copyImage(options: { dataUrl: string }): Promise<void>;
  addListener(
    eventName: "resume",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "progress",
    listener: (event: NativeDownloadProgress) => void,
  ): Promise<PluginListenerHandle>;
};

export const legacyNativeDownload =
  registerPlugin<NativeDownloadPlugin>("OneDropDownload");
const scopedMethods = new Set([
  "download",
  "cancel",
  "status",
  "open",
  "export",
  "showInFolder",
]);
export const nativeDownload = new Proxy(legacyNativeDownload, {
  get(target, property) {
    const method = Reflect.get(target, property);
    if (!scopedMethods.has(String(property))) return method;
    return async (options: { driveItemId: string }) => {
      assertAccountSession();
      const result = await method({
        ...options,
        driveItemId: scopedDownloadId(options.driveItemId),
      });
      assertAccountSession();
      return result;
    };
  },
});
