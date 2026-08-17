import type { Attachment, Message } from "@onedrop/core/domain/message";
import type { DeletedMessageItem } from "@onedrop/core/domain/deleted-message";
import type {
  AccountSettings,
  DevicePlatform,
  DeviceSettings,
  SettingsSnapshot,
} from "@onedrop/core/domain/settings";

export type MobileDownloadStatus = {
  driveItemId: string;
  state: "waiting" | "downloading" | "complete" | "failed" | "cancelled";
  filename: string;
  sourceUrl: string;
  startedAt: number;
  updatedAt: number;
  lastActivityAt: number;
  lastFingerprint?: string;
  downloadId?: number;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
};

export type AuthStatus =
  | { state: "unconfigured"; redirectUri: string }
  | { state: "signed-out"; redirectUri: string }
  | {
      state: "signed-in";
      redirectUri: string;
      account: { displayName?: string; username?: string };
      expiresAt: string;
    };

export type RuntimeRequest =
  | { type: "auth/status" }
  | { type: "auth/sign-in" }
  | { type: "auth/sign-out" }
  | { type: "device/id" }
  | { type: "settings/read"; platform: DevicePlatform; deviceName: string }
  | { type: "settings/save-account"; account: AccountSettings }
  | { type: "settings/save-device"; device: DeviceSettings }
  | {
      type: "settings/copy-device";
      sourceDeviceId: string;
      platform: DevicePlatform;
    }
  | { type: "settings/reset-device"; platform: DevicePlatform }
  | { type: "app/open-project" }
  | { type: "onedrive/verify-app-folder" }
  | { type: "onedrive/open-app-folder" }
  | { type: "messages/read-current-month" }
  | { type: "messages/read-month"; month: string }
  | { type: "archives/check" }
  | { type: "archives/retry"; month: string }
  | { type: "archives/dismiss"; month: string }
  | { type: "messages/delete"; messageId: string; month: string }
  | { type: "messages/delete-corrupt-file"; itemId: string }
  | { type: "messages/open-corrupt-file-location"; itemId: string }
  | {
      type: "messages/resolve-conflict";
      messageId: string;
      keepItemId: string;
    }
  | {
      type: "messages/send-text";
      text: string;
      messageId?: string;
      createdAt?: string;
    }
  | {
      type: "files/send";
      file: {
        name: string;
        mimeType: string;
        size: number;
        base64?: string;
        imageWidth?: number;
        imageHeight?: number;
        thumbHash?: string;
      };
      messageId: string;
      createdAt: string;
      reuseExisting?: boolean;
    }
  | { type: "files/cancel"; messageId: string }
  | {
      type: "files/retry-commit";
      attachment: Attachment;
      messageId: string;
      createdAt: string;
    }
  | { type: "files/discard-placeholder"; messageId: string }
  | { type: "files/read-preview"; driveItemId: string; mimeType: string }
  | { type: "files/check-attachment"; driveItemId: string }
  | { type: "files/check-cleanup" }
  | { type: "files/get-download-url"; driveItemId: string }
  | { type: "files/prepare-mobile-download"; attachment: Attachment }
  | { type: "files/mobile-download-status"; driveItemId: string }
  | { type: "files/cancel-mobile-download"; driveItemId: string }
  | { type: "files/clear-mobile-download"; driveItemId: string }
  | { type: "deleted-data/clean-now" }
  | { type: "deleted-data/read" }
  | {
      type: "deleted-data/restore";
      messageId: string;
      month: string;
    }
  | {
      type: "files/open-local";
      attachment: Attachment;
      forceDownload?: boolean;
    }
  | { type: "files/save-as"; attachment: Attachment }
  | { type: "files/open-in-onedrive"; driveItemId: string }
  | { type: "files/show-in-folder"; downloadId: number };

export type AppFolderSummary = {
  id: string;
  name: string;
  webUrl?: string;
};

export type CorruptMonthFile = { itemId: string; name: string };
export type MessageConflictVersion = {
  itemId: string;
  name: string;
  line: number;
};
export type MessageConflict = {
  messageId: string;
  versions: MessageConflictVersion[];
};

export type MonthReadResult =
  | {
      state: "missing";
      month: string;
      corruptFiles?: CorruptMonthFile[];
      messageConflicts?: MessageConflict[];
    }
  | {
      state: "loaded";
      month: string;
      eTag: string;
      messages: Message[];
      corruptFiles?: CorruptMonthFile[];
      messageConflicts?: MessageConflict[];
    };

export type ArchiveNotice = {
  month: string;
  phase: "failed" | "running" | "succeeded";
};

export type ArchiveRuntimeEvent = {
  type: "archives/event";
  notice: ArchiveNotice;
};

export type FileTransferRuntimeEvent = {
  type: "files/progress";
  messageId: string;
  uploadedBytes: number;
  segmentEndBytes: number;
  totalBytes: number;
  averageUploadBytesPerSecond?: number;
};

export type RuntimeResponse =
  | { ok: true; type: "auth/status"; status: AuthStatus }
  | { ok: true; type: "device/id"; deviceId: string }
  | { ok: true; type: "settings/snapshot"; snapshot: SettingsSnapshot }
  | { ok: true; type: "settings/account"; account: AccountSettings }
  | { ok: true; type: "settings/device"; device: DeviceSettings }
  | { ok: true; type: "app/project-opened" }
  | {
      ok: true;
      type: "onedrive/app-folder";
      appFolder: AppFolderSummary;
    }
  | { ok: true; type: "onedrive/app-folder-opened" }
  | { ok: true; type: "archives/notices"; notices: ArchiveNotice[] }
  | { ok: true; type: "archives/notice"; notice?: ArchiveNotice }
  | { ok: true; type: "archives/dismissed" }
  | {
      ok: true;
      type: "messages/month";
      result: MonthReadResult;
    }
  | { ok: true; type: "messages/deleted"; result: MonthReadResult }
  | { ok: true; type: "messages/corrupt-file-deleted" }
  | { ok: true; type: "messages/corrupt-file-location-opened" }
  | { ok: true; type: "messages/conflict-resolved"; result: MonthReadResult }
  | {
      ok: true;
      type: "files/transfer";
      transfer:
        | { state: "sent"; result: MonthReadResult }
        | { state: "upload-failed"; error: string }
        | {
            state: "reconciling";
            error: string;
            attachment: Attachment;
            createdAt: string;
          };
    }
  | { ok: true; type: "files/preview"; dataUrl: string }
  | { ok: true; type: "files/availability"; exists: boolean }
  | { ok: true; type: "files/placeholder-discarded" }
  | { ok: true; type: "files/cancelled" }
  | { ok: true; type: "files/cleanup-checked"; cleaned: number }
  | { ok: true; type: "files/download-url"; url: string }
  | {
      ok: true;
      type: "files/mobile-download";
      download?: MobileDownloadStatus;
    }
  | { ok: true; type: "files/mobile-download-cleared" }
  | {
      ok: true;
      type: "deleted-data/cleaned";
      messages: number;
      attachments: number;
    }
  | {
      ok: true;
      type: "deleted-data/items";
      items: DeletedMessageItem[];
    }
  | {
      ok: true;
      type: "deleted-data/restored";
      item: DeletedMessageItem;
      result: MonthReadResult;
    }
  | {
      ok: true;
      type: "files/local-action";
      action: "downloaded";
      downloadId: number;
    }
  | {
      ok: true;
      type: "files/local-action";
      action: "open";
      downloadId: number;
    }
  | { ok: true; type: "files/onedrive-opened" }
  | { ok: true; type: "files/folder-shown"; exists: boolean }
  | { ok: false; error: string };
