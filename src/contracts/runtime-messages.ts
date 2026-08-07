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
  | { type: "messages/read-current-month" }
  | { type: "messages/send-text"; text: string }
  | {
      type: "files/send";
      file: { name: string; mimeType: string; size: number; base64: string };
      messageId: string;
      createdAt: string;
    }
  | {
      type: "files/retry-commit";
      attachment: Attachment;
      messageId: string;
      createdAt: string;
    };

export type AppFolderSummary = {
  id: string;
  name: string;
  webUrl?: string;
};

export type MonthReadResult =
  | { state: "missing"; month: string }
  | {
      state: "loaded";
      month: string;
      eTag: string;
      messages: Message[];
    };

export type RuntimeResponse =
  | { ok: true; type: "auth/status"; status: AuthStatus }
  | { ok: true; type: "device/id"; deviceId: string }
  | {
      ok: true;
      type: "onedrive/app-folder";
      appFolder: AppFolderSummary;
    }
  | {
      ok: true;
      type: "messages/month";
      result: MonthReadResult;
    }
  | {
      ok: true;
      type: "files/transfer";
      transfer:
        | { state: "sent"; result: MonthReadResult }
        | { state: "upload-failed"; error: string }
        | { state: "commit-failed"; error: string; attachment: Attachment };
    }
  | { ok: false; error: string };
