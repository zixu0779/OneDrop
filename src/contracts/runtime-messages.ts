import type { Attachment, Message } from "../domain/message";

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
  | { type: "onedrive/verify-app-folder" }
  | { type: "onedrive/open-app-folder" }
  | { type: "dev/rebuild-test-data" }
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
  | {
      type: "files/open-local";
      attachment: Attachment;
      forceDownload?: boolean;
    }
  | { type: "files/save-as"; attachment: Attachment };

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
  | {
      ok: true;
      type: "onedrive/app-folder";
      appFolder: AppFolderSummary;
    }
  | { ok: true; type: "onedrive/app-folder-opened" }
  | { ok: true; type: "dev/test-data-rebuilt" }
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
  | { ok: false; error: string };
