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
  | { type: "auth/sign-out" };

export type RuntimeResponse =
  { ok: true; status: AuthStatus } | { ok: false; error: string };
