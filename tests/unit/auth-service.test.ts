import { beforeEach, describe, expect, it, vi } from "vitest";

const identityToken = (sub = "account-a") =>
  `header.${btoa(JSON.stringify({ iss: "https://issuer.example", sub, name: sub }))}.signature`;
const accountKey = (sub = "account-a") =>
  JSON.stringify(["https://issuer.example", sub]);
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
    id_token: identityToken(),
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
  const tabUpdatedListeners = new Set<
    (tabId: number, changeInfo: { url?: string }) => void
  >();
  const tabRemovedListeners = new Set<(tabId: number) => void>();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubEnv("WXT_ONEDROP_ENTRA_CLIENT_ID", "client-id");
    for (const key of Object.keys(localState)) delete localState[key];
    for (const key of Object.keys(sessionState)) delete sessionState[key];
    tabUpdatedListeners.clear();
    tabRemovedListeners.clear();

    vi.stubGlobal("browser", {
      identity: {
        getRedirectURL: vi.fn(() => "https://extension.chromiumapp.org/auth"),
        launchWebAuthFlow: vi.fn(),
      },
      storage: {
        local: storageArea(localState),
        session: storageArea(sessionState),
      },
      tabs: {
        create: vi.fn(async () => ({ id: 17 })),
        query: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        onUpdated: {
          addListener: vi.fn((listener) => tabUpdatedListeners.add(listener)),
          removeListener: vi.fn((listener) =>
            tabUpdatedListeners.delete(listener),
          ),
        },
        onRemoved: {
          addListener: vi.fn((listener) => tabRemovedListeners.add(listener)),
          removeListener: vi.fn((listener) =>
            tabRemovedListeners.delete(listener),
          ),
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("restores a still-valid token from persistent extension storage", async () => {
    localState["onedrop.auth.token"] = token();
    const { getCurrentAccessToken } =
      await import("@onedrop/app-runtime/features/auth/auth-service");

    await expect(getCurrentAccessToken()).resolves.toBe("old-access-token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a normal Edge tab for SPA sign-in when Android cannot create an identity window", async () => {
    vi.mocked(browser.identity.launchWebAuthFlow).mockRejectedValue(
      new Error("Couldn't create a browser window"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id_token: identityToken(),
          token_type: "Bearer",
          scope: "openid offline_access",
          expires_in: 3600,
          access_token: "android-spa-access-token",
          refresh_token: "android-spa-refresh-token",
        }),
      ),
    );
    const { signIn } =
      await import("@onedrop/app-runtime/features/auth/auth-service");

    const signInPromise = signIn();
    await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalled());
    const authorizeUrl = new URL(
      vi.mocked(browser.tabs.create).mock.calls[0]![0].url!,
    );
    for (const listener of tabUpdatedListeners) {
      listener(17, {
        url: `https://extension.chromiumapp.org/auth?code=android-code&state=${authorizeUrl.searchParams.get("state")}`,
      });
    }

    await expect(signInPromise).resolves.toMatchObject({ state: "signed-in" });
    expect(browser.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
    expect(browser.tabs.remove).toHaveBeenCalledWith(17);
    expect(
      (
        localState["onedrop.auth.accounts.v1"] as {
          tokens: Record<string, Record<string, unknown>>;
        }
      ).tokens[accountKey()]!.refresh_token,
    ).toBe("android-spa-refresh-token");
  });

  it("uses the reachable SPA redirect and a tab when the identity API is absent", async () => {
    vi.stubGlobal("browser", {
      ...browser,
      identity: undefined,
      runtime: { id: "ios-edge-extension" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id_token: identityToken(),
          token_type: "Bearer",
          scope: "openid offline_access",
          expires_in: 3600,
          access_token: "ios-edge-access-token",
          refresh_token: "ios-edge-refresh-token",
        }),
      ),
    );
    const { getAuthStatus, signIn } =
      await import("@onedrop/app-runtime/features/auth/auth-service");

    await expect(getAuthStatus()).resolves.toMatchObject({
      state: "signed-out",
      redirectUri: "https://onedrop.sycamore.top/auth.html",
    });
    const signInPromise = signIn();
    await vi.waitFor(() => expect(browser.tabs.create).toHaveBeenCalled());
    const authorizeUrl = new URL(
      vi.mocked(browser.tabs.create).mock.calls[0]![0].url!,
    );
    for (const listener of tabUpdatedListeners) {
      listener(17, {
        url: `https://onedrop.sycamore.top/auth.html?code=ios-code&state=${authorizeUrl.searchParams.get("state")}`,
      });
    }

    await expect(signInPromise).resolves.toMatchObject({ state: "signed-in" });
  });

  it("resumes a completed tab callback after the extension background was suspended", async () => {
    localState["onedrop.auth.pending"] = {
      state: "saved-state",
      verifier: "saved-verifier",
      redirectUri: "https://onedrop.sycamore.top/auth.html",
      createdAt: Date.now(),
      interactive: true,
    };
    const queryTabs = browser.tabs.query as unknown as {
      mockResolvedValue(value: Array<{ id?: number; url?: string }>): void;
    };
    queryTabs.mockResolvedValue([
      {
        id: 44,
        url: "https://onedrop.sycamore.top/auth.html?code=resumed-code&state=saved-state",
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id_token: identityToken(),
          token_type: "Bearer",
          scope: "openid offline_access",
          expires_in: 3600,
          access_token: "resumed-access-token",
          refresh_token: "resumed-refresh-token",
        }),
      ),
    );
    const { getAuthStatus, resumePendingTabAuthorization } =
      await import("@onedrop/app-runtime/features/auth/auth-service");
    await resumePendingTabAuthorization();
    await expect(getAuthStatus()).resolves.toMatchObject({
      state: "signed-in",
    });
    expect(browser.tabs.remove).toHaveBeenCalledWith(44);
    expect(localState["onedrop.auth.pending"]).toBeUndefined();
  });

  it("refreshes an expired access token and retains the refresh token when Microsoft omits a replacement", async () => {
    localState["onedrop.auth.token"] = token({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id_token: identityToken(),
          token_type: "Bearer",
          scope: "openid offline_access",
          expires_in: 3600,
          access_token: "new-access-token",
        }),
      ),
    );
    const { getCurrentAccessToken } =
      await import("@onedrop/app-runtime/features/auth/auth-service");

    await expect(getCurrentAccessToken()).resolves.toBe("new-access-token");
    expect(
      (
        localState["onedrop.auth.accounts.v1"] as {
          tokens: Record<string, Record<string, unknown>>;
        }
      ).tokens[accountKey()]!.refresh_token,
    ).toBe("refresh-token");
  });

  it("retains an expired account for offline access and marks it for sign-in", async () => {
    localState["onedrop.auth.token"] = token({
      expiresAt: new Date(0).toISOString(),
    });
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    const auth =
      await import("@onedrop/app-runtime/features/auth/auth-service");
    await expect(auth.getAuthStatus()).resolves.toMatchObject({
      state: "signed-in",
    });
    expect((await auth.listAccounts()).accounts).toMatchObject([
      { key: accountKey(), signInRequired: true },
    ]);
    expect(browser.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("sign-out deletes saved credentials and selects the most recently used remaining account", async () => {
    const a = accountKey(),
      b = accountKey("account-b"),
      c = accountKey("account-c");
    localState["onedrop.auth.accounts.v1"] = {
      activeKey: a,
      tokens: {
        [a]: token(),
        [b]: token({ id_token: identityToken("account-b") }),
        [c]: token({ id_token: identityToken("account-c") }),
      },
      lastUsed: { [a]: 3, [b]: 2, [c]: 1 },
      required: {},
    };
    localState["onedrop.edge.A.downloads"] = { kept: true };
    const auth =
      await import("@onedrop/app-runtime/features/auth/auth-service");
    expect((await auth.signOut()).state).toBe("signed-in");
    expect((await auth.listAccounts()).activeKey).toBe(b);
    await expect(auth.switchAccount(a)).rejects.toThrow("no longer available");
    expect(localState["onedrop.edge.A.downloads"]).toEqual({ kept: true });
    await auth.removeAccount(c);
    expect((await auth.listAccounts()).activeKey).toBe(b);
    expect((await auth.signOut()).state).toBe("signed-out");
    expect((await auth.listAccounts()).accounts).toHaveLength(0);
  });

  it("adding and reauthenticating deduplicate stable identity and preserve active account on failure", async () => {
    localState["onedrop.auth.token"] = token();
    const auth =
      await import("@onedrop/app-runtime/features/auth/auth-service");
    vi.mocked(browser.identity.launchWebAuthFlow).mockImplementation(
      async ({ url }) => {
        const request = new URL(url);
        return `https://extension.chromiumapp.org/auth?code=synthetic&state=${request.searchParams.get("state")}`;
      },
    );
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json(token({ id_token: identityToken("account-b") })),
    );
    await auth.signIn();
    expect((await auth.listAccounts()).activeKey).toBe(accountKey("account-b"));
    await auth.signIn();
    expect((await auth.listAccounts()).accounts).toHaveLength(2);
    await expect(auth.signIn(accountKey())).rejects.toThrow(
      "selected Microsoft account",
    );
    expect((await auth.listAccounts()).activeKey).toBe(accountKey("account-b"));
    vi.mocked(browser.identity.launchWebAuthFlow).mockRejectedValue(
      new Error("cancelled"),
    );
    await expect(auth.signIn()).rejects.toThrow("cancelled");
    expect((await auth.listAccounts()).accounts).toHaveLength(2);
  });

  it.each([true, false])(
    "forgetting an inactive account cancels a suspended auth flow (reauth: %s)",
    async (reauth) => {
      const a = accountKey(),
        b = accountKey("account-b");
      localState["onedrop.auth.accounts.v1"] = {
        activeKey: a,
        tokens: {
          [a]: token(),
          [b]: token({ id_token: identityToken("account-b") }),
        },
        lastUsed: {},
        required: {},
      };
      localState["onedrop.auth.pending"] = {
        state: "saved-state",
        verifier: "saved-verifier",
        redirectUri: "https://onedrop.sycamore.top/auth.html",
        createdAt: Date.now(),
        interactive: true,
        ...(reauth ? { expectedKey: b } : {}),
        originalActiveKey: a,
      };
      const auth =
        await import("@onedrop/app-runtime/features/auth/auth-service");
      await auth.removeAccount(b);
      expect(localState["onedrop.auth.pending"]).toBeUndefined();
      vi.mocked(browser.tabs.query).mockResolvedValue([
        {
          id: 44,
          url: "https://onedrop.sycamore.top/auth.html?code=late&state=saved-state",
        },
      ] as never);
      await auth.resumePendingTabAuthorization();
      expect(fetch).not.toHaveBeenCalled();
      expect((await auth.listAccounts()).accounts.map((x) => x.key)).toEqual([
        a,
      ]);
    },
  );

  it("caps at three accounts and rejects late refresh after removal", async () => {
    const accounts = {
      activeKey: accountKey(),
      tokens: Object.fromEntries(
        ["account-a", "account-b", "account-c"].map((sub) => [
          accountKey(sub),
          token({
            id_token: identityToken(sub),
            expiresAt: new Date(0).toISOString(),
          }),
        ]),
      ),
      lastUsed: {},
      required: {},
    };
    localState["onedrop.auth.accounts.v1"] = accounts;
    const auth =
      await import("@onedrop/app-runtime/features/auth/auth-service");
    await expect(auth.signIn()).rejects.toThrow("three accounts");
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const refresh = auth.getCurrentAccessToken();
    const assertion = expect(refresh).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await auth.removeAccount(accountKey());
    complete(Response.json(token()));
    await assertion;
    expect(
      (await auth.listAccounts()).accounts.some(
        (account) => account.key === accountKey(),
      ),
    ).toBe(false);
  });
});
