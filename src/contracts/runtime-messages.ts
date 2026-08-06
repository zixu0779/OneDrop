export type AuthStatus =
  | {
      state: "unconfigured";
      redirectUri: string;
    }
  | {
      state: "signed-out";
      redirectUri: string;
    }
  | {
      state: "signed-in";
      redirectUri: string;
      account: {
        displayName?: string;
        username?: string;
      };
      expiresAt: string;
    };

export type RuntimeRequest =
  | { type: "auth/status" }
  | { type: "auth/sign-in" }
  | { type: "auth/sign-out" }
  | { type: "onedrive/verify-app-folder" }
  | { type: "messages/read-current-month" };

export type AppFolderSummary = {
  id: string;
  name: string;
  webUrl?: string;
};

export type MonthReadResult =
  | {
      state: "missing";
      month: string;
    }
  | {
      state: "loaded";
      month: string;
      eTag: string;
      messages: Message[];
    };

export type RuntimeResponse =
  | { ok: true; type: "auth/status"; status: AuthStatus }
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
  | { ok: false; error: string };
import type { Message } from "../domain/message";
