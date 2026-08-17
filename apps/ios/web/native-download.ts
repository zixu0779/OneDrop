import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeDownloadProgress = {
  driveItemId: string;
  receivedBytes: number;
  totalBytes: number;
};

type NativeDownloadPlugin = {
  download(options: {
    url: string;
    driveItemId: string;
    fileName: string;
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
    eventName: "progress",
    listener: (event: NativeDownloadProgress) => void,
  ): Promise<PluginListenerHandle>;
};

export const nativeDownload =
  registerPlugin<NativeDownloadPlugin>("OneDropDownload");
