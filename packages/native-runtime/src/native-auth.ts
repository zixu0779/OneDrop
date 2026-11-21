import { registerPlugin } from "@capacitor/core";

export type NativeAuthStatus = {
  state: "signed-in" | "signed-out";
  redirectUri: string;
  expiresAt?: string;
  account?: {
    displayName?: string;
    username?: string;
  };
};

type NativeAuthPlugin = {
  status(): Promise<NativeAuthStatus>;
  signIn(options: {
    clientId: string;
    authority?: string;
  }): Promise<NativeAuthStatus>;
  getAccessToken(): Promise<{ accessToken: string }>;
  signOut(): Promise<NativeAuthStatus>;
};

export const nativeAuth = registerPlugin<NativeAuthPlugin>("OneDropAuth");

export function getNativeAuthConfiguration() {
  return {
    clientId: import.meta.env.WXT_ONEDROP_ENTRA_CLIENT_ID?.trim() ?? "",
    authority:
      import.meta.env.WXT_ONEDROP_ENTRA_AUTHORITY?.trim() ||
      "https://login.microsoftonline.com/common",
  };
}
