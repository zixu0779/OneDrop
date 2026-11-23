import { pauseLocalAccountWork } from "@onedrop/app-runtime/features/auth/account-work";
import type { LocalAccounts } from "@onedrop/core/domain/local-account";
import { registerPlugin } from "@capacitor/core";
import {
  assertAccountSession,
  closeAccountSession,
  matchesAccount,
} from "./account-session";

export type NativeAuthStatus = {
  state: "signed-in" | "signed-out";
  redirectUri: string;
  expiresAt?: string;
  accountKey?: string;
  account?: {
    displayName?: string;
    username?: string;
  };
};

type NativeAuthPlugin = {
  resetAuthorization(): Promise<void>;
  prepareSignIn(options: {
    clientId: string;
    authority?: string;
    reauthenticateKey?: string;
    attemptId: string;
  }): Promise<{ candidateId: string }>;
  commitSignIn(options: { candidateId: string }): Promise<NativeAuthStatus>;
  discardSignIn(options: { attemptId: string }): Promise<void>;
  listAccounts(): Promise<LocalAccounts>;
  switchAccount(options: { accountKey: string }): Promise<NativeAuthStatus>;
  removeAccount(options: { accountKey: string }): Promise<void>;
  status(): Promise<NativeAuthStatus>;
  signIn(options: {
    clientId: string;
    authority?: string;
    reauthenticateKey?: string;
  }): Promise<NativeAuthStatus>;
  getAccessToken(): Promise<{ accessToken: string; accountKey: string }>;
  signOut(): Promise<NativeAuthStatus>;
};

export const nativeAuthPlugin = registerPlugin<NativeAuthPlugin>("OneDropAuth");

export async function restartNativeAccount(): Promise<never> {
  closeAccountSession();
  await pauseLocalAccountWork().catch(() => undefined);
  window.location.reload();
  return new Promise(() => {});
}
export const nativeAuth: NativeAuthPlugin = {
  resetAuthorization: () => nativeAuthPlugin.resetAuthorization(),
  prepareSignIn: (options) => nativeAuthPlugin.prepareSignIn(options),
  commitSignIn: (options) => nativeAuthPlugin.commitSignIn(options),
  discardSignIn: (options) => nativeAuthPlugin.discardSignIn(options),
  listAccounts: () => nativeAuthPlugin.listAccounts(),
  switchAccount: async (options) => {
    await nativeAuthPlugin.switchAccount(options);
    return restartNativeAccount();
  },
  removeAccount: async (options) => {
    await nativeAuthPlugin.removeAccount(options);
    return restartNativeAccount();
  },
  async status() {
    assertAccountSession();
    const result = await nativeAuthPlugin.status();
    if (!matchesAccount(result.accountKey)) return restartNativeAccount();
    assertAccountSession();
    return result;
  },
  async signIn(options) {
    assertAccountSession();
    await nativeAuthPlugin.signIn(options);
    return restartNativeAccount();
  },
  async signOut() {
    await nativeAuthPlugin.signOut();
    return restartNativeAccount();
  },
  async getAccessToken() {
    assertAccountSession();
    const result = await nativeAuthPlugin.getAccessToken();
    if (!result.accountKey)
      throw new Error("Microsoft account identity is unavailable.");
    assertAccountSession(result.accountKey);
    return result;
  },
};

export function getNativeAuthConfiguration() {
  return {
    clientId: import.meta.env.WXT_ONEDROP_ENTRA_CLIENT_ID?.trim() ?? "",
    authority:
      import.meta.env.WXT_ONEDROP_ENTRA_AUTHORITY?.trim() ||
      "https://login.microsoftonline.com/common",
  };
}
