import { beforeEach, describe, expect, it, vi } from "vitest";

type StorageState = Record<string, unknown>;

function storageArea(state: StorageState) {
  return {
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (values: StorageState) => {
      Object.assign(state, values);
    }),
    remove: vi.fn(async (key: string) => {
      delete state[key];
    }),
  };
}

function token(overrides: Record<string, unknown> = {}) {
  return {
    token_type: "Bearer",
    scope: "openid offline_access",
    expires_in: 3600,
    access_token: "old-access-token",
    refresh_token: "refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("persistent authentication lifecycle", () => {
  const localState: StorageState = {};
  const sessionState: StorageState = {};

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubEnv("WXT_ONEDROP_ENTRA_CLIENT_ID", "client-id");
    for (const key of Object.keys(localState)) delete localState[key];
    for (const key of Object.keys(sessionState)) delete sessionState[key];

    vi.stubGlobal("browser", {
      identity: {
        getRedirectURL: vi.fn(() => "https://extension.chromiumapp.org/auth"),
        launchWebAuthFlow: vi.fn(),
      },
      storage: {
        local: storageArea(localState),
        session: storageArea(sessionState),
      },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("restores a still-valid token from persistent extension storage", async () => {
    localState["onedrop.auth.token"] = token();
    const { getCurrentAccessToken } =
      await import("../../src/features/auth/auth-service");

    await expect(getCurrentAccessToken()).resolves.toBe("old-access-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token and retains the refresh token when Microsoft omits a replacement", async () => {
    localState["onedrop.auth.token"] = token({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          token_type: "Bearer",
          scope: "openid offline_access",
          expires_in: 3600,
          access_token: "new-access-token",
        }),
      ),
    );
    const { getCurrentAccessToken } =
      await import("../../src/features/auth/auth-service");

    await expect(getCurrentAccessToken()).resolves.toBe("new-access-token");
    expect(
      (localState["onedrop.auth.token"] as Record<string, unknown>)
        .refresh_token,
    ).toBe("refresh-token");
  });

  it("silently obtains a new authorization grant when the 24-hour SPA refresh grant expires", async () => {
    localState["onedrop.auth.token"] = token({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const launchWebAuthFlow = vi.mocked(browser.identity.launchWebAuthFlow);
    launchWebAuthFlow.mockImplementation(async ({ url, interactive }) => {
      expect(interactive).toBe(false);
      const authorizeUrl = new URL(url);
      expect(authorizeUrl.searchParams.get("prompt")).toBe("none");
      return `https://extension.chromiumapp.org/auth?code=fresh-code&state=${authorizeUrl.searchParams.get("state")}`;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              error: "invalid_grant",
              error_description: "AADSTS70000: The grant is expired.",
            },
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            token_type: "Bearer",
            scope: "openid offline_access",
            expires_in: 3600,
            access_token: "silent-access-token",
            refresh_token: "fresh-refresh-token",
          }),
        ),
    );
    const { getCurrentAccessToken } =
      await import("../../src/features/auth/auth-service");

    await expect(getCurrentAccessToken()).resolves.toBe("silent-access-token");
    expect(
      (localState["onedrop.auth.token"] as Record<string, unknown>)
        .refresh_token,
    ).toBe("fresh-refresh-token");
  });

  it("returns signed-out when both the refresh grant and Microsoft browser session have ended", async () => {
    localState["onedrop.auth.token"] = token({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    vi.mocked(browser.identity.launchWebAuthFlow).mockRejectedValue(
      new Error("Interaction required"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: "invalid_grant",
            error_description: "AADSTS70000: The grant is expired.",
          },
          { status: 400 },
        ),
      ),
    );
    const { getAuthStatus } =
      await import("../../src/features/auth/auth-service");

    await expect(getAuthStatus()).resolves.toMatchObject({
      state: "signed-out",
    });
    expect(localState["onedrop.auth.token"]).toBeUndefined();
  });

  it("clears persistent and legacy session tokens on sign out", async () => {
    localState["onedrop.auth.token"] = token();
    sessionState["onedrop.auth.token"] = token();
    const { signOut } = await import("../../src/features/auth/auth-service");

    const status = await signOut();

    expect(status.state).toBe("signed-out");
    expect(localState["onedrop.auth.token"]).toBeUndefined();
    expect(sessionState["onedrop.auth.token"]).toBeUndefined();
  });
});
