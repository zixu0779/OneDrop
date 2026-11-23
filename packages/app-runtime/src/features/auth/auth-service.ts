import {
  accountIdentity,
  MAX_LOCAL_ACCOUNTS,
  type LocalAccounts,
} from "@onedrop/core/domain/local-account";
import type { AuthStatus } from "@onedrop/core/contracts/runtime-messages";
import { z } from "zod";
import { createPkcePair, createRandomBase64Url } from "./pkce";
import {
  readUnverifiedIdTokenClaims,
  tokenResponseSchema,
  type TokenResponse,
} from "./token";

const ACCOUNTS_STORAGE_KEY = "onedrop.auth.accounts.v1";
const TOKEN_STORAGE_KEY = "onedrop.auth.token";
const PENDING_AUTH_STORAGE_KEY = "onedrop.auth.pending";
const EXPIRY_SKEW_MS = 60_000;
const PENDING_AUTH_MAX_AGE_MS = 5 * 60_000;
const REDIRECT_PATH = "auth";
const DEFAULT_TAB_REDIRECT_URI = "https://onedrop.sycamore.top/auth.html";
const SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Files.ReadWrite",
] as const;

type StoredToken = TokenResponse & {
  expiresAt: string;
};

type PendingAuthorization = {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
  interactive: boolean;
  expectedKey?: string | undefined;
  originalActiveKey?: string | undefined;
};

function getClientId(): string | undefined {
  const clientId = import.meta.env.WXT_ONEDROP_ENTRA_CLIENT_ID?.trim();
  return clientId || undefined;
}

function getAuthority(): string {
  return (
    import.meta.env.WXT_ONEDROP_ENTRA_AUTHORITY?.trim() ||
    "https://login.microsoftonline.com/common"
  ).replace(/\/$/u, "");
}

function getRedirectUri(): string {
  const identity = getIdentityApi();
  return identity?.getRedirectURL
    ? identity.getRedirectURL(REDIRECT_PATH)
    : getTabRedirectUri();
}

function getTabRedirectUri(): string {
  return (
    import.meta.env.WXT_ONEDROP_TAB_REDIRECT_URI?.trim() ||
    DEFAULT_TAB_REDIRECT_URI
  );
}

function getIdentityApi():
  | {
      getRedirectURL?(path?: string): string;
      launchWebAuthFlow?(details: {
        url: string;
        interactive?: boolean;
      }): Promise<string | undefined>;
    }
  | undefined {
  return (
    browser as typeof browser & {
      identity?: {
        getRedirectURL?(path?: string): string;
        launchWebAuthFlow?(details: {
          url: string;
          interactive?: boolean;
        }): Promise<string | undefined>;
      };
    }
  ).identity;
}

const zStoredToken = tokenResponseSchema.extend({
  expiresAt: z.iso.datetime(),
});
type AccountStore = {
  activeKey?: string | undefined;
  tokens: Record<string, StoredToken>;
  lastUsed: Record<string, number>;
  required: Record<string, boolean>;
};
let mutationTail: Promise<unknown> = Promise.resolve();
function mutateAccounts<T>(
  operation: (store: AccountStore) => Promise<T>,
): Promise<T> {
  const result = mutationTail.then(async () => {
    const store = await readAccounts();
    const result = await operation(store);
    await browser.storage.local.set({ [ACCOUNTS_STORAGE_KEY]: store });
    return result;
  });
  mutationTail = result.catch(() => undefined);
  return result;
}
async function readAccounts(): Promise<AccountStore> {
  const saved = await browser.storage.local.get(ACCOUNTS_STORAGE_KEY);
  const existing = saved[ACCOUNTS_STORAGE_KEY] as AccountStore | undefined;
  if (existing) return existing;
  const store: AccountStore = { tokens: {}, lastUsed: {}, required: {} };
  const local = await browser.storage.local.get(TOKEN_STORAGE_KEY);
  const session = await browser.storage.session.get(TOKEN_STORAGE_KEY);
  const legacy = zStoredToken.safeParse(
    local[TOKEN_STORAGE_KEY] ?? session[TOKEN_STORAGE_KEY],
  ).data;
  if (legacy) {
    // Only credentials have an identity; never claim the old unscoped message database.
    const key = accountIdentity(readUnverifiedIdTokenClaims(legacy.id_token));
    store.tokens[key] = legacy;
    store.activeKey = key;
    store.lastUsed[key] = Date.now();
  }
  return store;
}
async function readStoredToken(): Promise<StoredToken | undefined> {
  const store = await readAccounts();
  return store.activeKey ? store.tokens[store.activeKey] : undefined;
}
const refreshInFlight = new Map<string, Promise<StoredToken | undefined>>();
class SignInRequiredError extends Error {}

async function storeToken(
  token: StoredToken,
  activate = false,
  expectedKey?: string,
  originalActiveKey?: string,
): Promise<void> {
  const key = accountIdentity(readUnverifiedIdTokenClaims(token.id_token));
  if (expectedKey && key !== expectedKey)
    throw new Error("Sign in with the selected Microsoft account.");
  await mutateAccounts(async (store) => {
    if (activate && store.activeKey !== originalActiveKey)
      throw new Error("The active account changed during sign-in. Try again.");
    if (
      !store.tokens[key] &&
      Object.keys(store.tokens).length >= MAX_LOCAL_ACCOUNTS
    )
      throw new Error(
        "You can keep up to three accounts. Remove one before adding another.",
      );
    if ((!activate || expectedKey) && !store.tokens[key])
      throw new Error("The account was removed.");
    store.tokens[key] = token;
    store.required[key] = false;
    if (activate) {
      store.activeKey = key;
      store.lastUsed[key] = Date.now();
    }
  });
}
async function markSignInRequired(key: string): Promise<void> {
  await mutateAccounts(async (store) => {
    if (store.tokens[key]) store.required[key] = true;
  });
}
export async function listAccounts(): Promise<LocalAccounts> {
  const store = await readAccounts();
  return {
    activeKey: store.activeKey,
    accounts: Object.entries(store.tokens)
      .map(([key, token]) => {
        const claims = readUnverifiedIdTokenClaims(token.id_token);
        return {
          key,
          displayName: claims.name,
          username: claims.preferred_username,
          lastUsedAt: store.lastUsed[key] ?? 0,
          signInRequired: store.required[key] ?? false,
        };
      })
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt),
  };
}
export async function switchAccount(key: string): Promise<void> {
  await mutateAccounts(async (store) => {
    if (!store.tokens[key])
      throw new Error("This account is no longer available.");
    store.activeKey = key;
    store.lastUsed[key] = Date.now();
  });
}
export async function removeAccount(key: string): Promise<void> {
  await mutateAccounts(async (store) => {
    delete store.tokens[key];
    delete store.lastUsed[key];
    delete store.required[key];
    if (store.activeKey === key)
      store.activeKey = Object.keys(store.tokens).sort(
        (a, b) => (store.lastUsed[b] ?? 0) - (store.lastUsed[a] ?? 0),
      )[0];
  });
  await browser.storage.local.remove(TOKEN_STORAGE_KEY);
  await browser.storage.session.remove(TOKEN_STORAGE_KEY);
  // A suspended browser flow predates this explicit removal; do not restore it later.
  await browser.storage.local.remove(PENDING_AUTH_STORAGE_KEY);
}

function isAccessTokenUsable(token: StoredToken): boolean {
  return Date.parse(token.expiresAt) > Date.now() + EXPIRY_SKEW_MS;
}

async function getUsableToken(): Promise<StoredToken | undefined> {
  const token = await readStoredToken();
  const store = await readAccounts();
  if (store.activeKey && store.required[store.activeKey])
    throw new SignInRequiredError("Sign in again to sync this account.");
  if (!token || isAccessTokenUsable(token)) return token;

  if (!token.refresh_token) {
    await markSignInRequired(
      accountIdentity(readUnverifiedIdTokenClaims(token.id_token)),
    );
    throw new SignInRequiredError("Sign in again to sync this account.");
  }

  const key = accountIdentity(readUnverifiedIdTokenClaims(token.id_token));
  let refresh = refreshInFlight.get(key);
  if (!refresh) {
    refresh = refreshAccessToken(token).finally(() =>
      refreshInFlight.delete(key),
    );
    refreshInFlight.set(key, refresh);
  }
  return refresh;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const redirectUri = getRedirectUri();

  if (!getClientId()) {
    return { state: "unconfigured", redirectUri };
  }

  const token = await getUsableToken().catch(() => readStoredToken());

  if (!token) {
    return { state: "signed-out", redirectUri };
  }

  const claims = readUnverifiedIdTokenClaims(token.id_token);

  return {
    state: "signed-in",
    redirectUri,
    account: {
      ...(claims.name ? { displayName: claims.name } : {}),
      ...(claims.preferred_username
        ? { username: claims.preferred_username }
        : {}),
    },
    expiresAt: token.expiresAt,
  };
}

export async function signIn(expectedKey?: string): Promise<AuthStatus> {
  const clientId = getClientId();

  if (!clientId) {
    throw new Error("Microsoft Entra Client ID is not configured.");
  }

  const accounts = await listAccounts();
  if (!expectedKey && accounts.accounts.length >= MAX_LOCAL_ACCOUNTS)
    throw new Error(
      "You can keep up to three accounts. Remove one before adding another.",
    );
  await acquireAuthorizationCodeToken({
    interactive: true,
    expectedKey,
    originalActiveKey: accounts.activeKey,
  });
  await browser.storage.session.remove(TOKEN_STORAGE_KEY);
  return getAuthStatus();
}

function shouldUseTabAuthorizationFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /couldn['’]?t create a browser window|cannot create a browser window/iu.test(
    message,
  );
}

async function launchTabAuthorizationFlow(
  url: string,
  redirectUri: string,
  interactive: boolean,
): Promise<string> {
  const tab = await browser.tabs.create({ url, active: interactive });
  if (tab.id === undefined) {
    throw new Error("Microsoft sign-in tab could not be created.");
  }

  const timeoutMs = interactive ? 5 * 60_000 : 30_000;
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (callback?: string, error?: Error) => {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(onUpdated);
        browser.tabs.onRemoved.removeListener(onRemoved);
        if (callback) resolve(callback);
        else reject(error ?? new Error("Microsoft sign-in was interrupted."));
      };
      const onUpdated = (
        updatedTabId: number,
        changeInfo: { url?: string },
      ) => {
        if (
          updatedTabId === tab.id &&
          changeInfo.url?.startsWith(redirectUri)
        ) {
          finish(changeInfo.url);
        }
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tab.id) {
          finish(
            undefined,
            new Error("Microsoft sign-in was cancelled before it completed."),
          );
        }
      };
      const timeout = setTimeout(
        () =>
          finish(
            undefined,
            new Error("Microsoft sign-in timed out. Try again."),
          ),
        timeoutMs,
      );
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
    });
  } finally {
    await browser.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function acquireAuthorizationCodeToken(options: {
  interactive: boolean;
  previous?: StoredToken;
  expectedKey?: string | undefined;
  originalActiveKey?: string | undefined;
}): Promise<StoredToken> {
  const clientId = getClientId();

  if (!clientId) {
    throw new Error("Microsoft Entra Client ID is not configured.");
  }

  const authority = getAuthority();
  const redirectUri = getRedirectUri();
  const state = createRandomBase64Url();
  const { verifier, challenge } = await createPkcePair();
  const authorizeUrl = new URL(`${authority}/oauth2/v2.0/authorize`);
  const previousClaims = readUnverifiedIdTokenClaims(
    options.previous?.id_token,
  );

  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: options.interactive ? "select_account" : "none",
    ...(previousClaims.preferred_username
      ? { login_hint: previousClaims.preferred_username }
      : {}),
  }).toString();

  let callbackUrl: string | undefined;
  const identity = getIdentityApi();
  try {
    if (!identity?.launchWebAuthFlow) {
      await storePendingAuthorization({
        state,
        verifier,
        redirectUri,
        createdAt: Date.now(),
        interactive: options.interactive,
        expectedKey: options.expectedKey,
        originalActiveKey: options.originalActiveKey,
      });
    }
    callbackUrl = identity?.launchWebAuthFlow
      ? await identity.launchWebAuthFlow({
          url: authorizeUrl.toString(),
          interactive: options.interactive,
        })
      : await launchTabAuthorizationFlow(
          authorizeUrl.toString(),
          redirectUri,
          options.interactive,
        );
  } catch (cause) {
    if (shouldUseTabAuthorizationFallback(cause)) {
      try {
        await storePendingAuthorization({
          state,
          verifier,
          redirectUri,
          createdAt: Date.now(),
          interactive: options.interactive,
          expectedKey: options.expectedKey,
          originalActiveKey: options.originalActiveKey,
        });
        callbackUrl = await launchTabAuthorizationFlow(
          authorizeUrl.toString(),
          redirectUri,
          options.interactive,
        );
      } catch (fallbackCause) {
        if (options.interactive) throw fallbackCause;
        throw new SignInRequiredError(
          "The Microsoft browser session cannot renew OneDrop silently.",
          { cause: fallbackCause },
        );
      }
    } else if (!options.interactive) {
      throw new SignInRequiredError(
        "The Microsoft browser session cannot renew OneDrop silently.",
        { cause },
      );
    } else {
      throw cause;
    }
  }

  if (!callbackUrl) {
    if (!options.interactive) {
      throw new SignInRequiredError("The Microsoft browser session has ended.");
    }
    throw new Error("Microsoft sign-in did not return a callback URL.");
  }

  const storedToken = await exchangeAuthorizationCallback(callbackUrl, {
    state,
    verifier,
    redirectUri,
    createdAt: Date.now(),
    interactive: options.interactive,
    expectedKey: options.expectedKey,
    originalActiveKey: options.originalActiveKey,
  });
  await browser.storage.local.remove(PENDING_AUTH_STORAGE_KEY);
  return storedToken;
}

async function exchangeAuthorizationCallback(
  callbackUrl: string,
  pending: PendingAuthorization,
): Promise<StoredToken> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error("Microsoft Entra Client ID is not configured.");
  }

  const callback = new URL(callbackUrl);
  const authError = callback.searchParams.get("error_description");

  if (authError) {
    if (!pending.interactive) {
      throw new SignInRequiredError(authError);
    }
    throw new Error(authError);
  }

  if (callback.searchParams.get("state") !== pending.state) {
    throw new Error("Microsoft sign-in state validation failed.");
  }

  const code = callback.searchParams.get("code");

  if (!code) {
    throw new Error("Microsoft sign-in did not return an authorization code.");
  }

  const tokenResponse = await fetch(`${getAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      scope: SCOPES.join(" "),
    }),
  });

  const tokenBody: unknown = await tokenResponse.json();

  if (!tokenResponse.ok) {
    const message = getTokenErrorMessage(tokenBody);
    if (!pending.interactive && isPermanentRefreshFailure(tokenBody)) {
      throw new SignInRequiredError(message);
    }
    throw new Error(`Microsoft token exchange failed: ${message}`);
  }

  const token = tokenResponseSchema.parse(tokenBody);
  const storedToken: StoredToken = {
    ...token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  };

  await storeToken(
    storedToken,
    pending.interactive,
    pending.expectedKey,
    pending.originalActiveKey,
  );
  return storedToken;
}

async function storePendingAuthorization(
  pending: PendingAuthorization,
): Promise<void> {
  await browser.storage.local.set({ [PENDING_AUTH_STORAGE_KEY]: pending });
}

let pendingResume: Promise<void> | undefined;
export async function resumePendingTabAuthorization(): Promise<void> {
  pendingResume ??= resumePendingAuthorizationOnce().finally(() => {
    pendingResume = undefined;
  });
  return pendingResume;
}
async function resumePendingAuthorizationOnce(): Promise<void> {
  const stored = await browser.storage.local.get(PENDING_AUTH_STORAGE_KEY);
  const pending = stored[PENDING_AUTH_STORAGE_KEY] as
    PendingAuthorization | undefined;
  if (!pending) return;
  if (Date.now() - pending.createdAt > PENDING_AUTH_MAX_AGE_MS) {
    await browser.storage.local.remove(PENDING_AUTH_STORAGE_KEY);
    return;
  }
  const tabs = await browser.tabs.query({});
  const callbackTab = tabs.find((tab) =>
    tab.url?.startsWith(pending.redirectUri),
  );
  if (!callbackTab?.url) return;
  try {
    await exchangeAuthorizationCallback(callbackTab.url, pending);
    await browser.storage.local.remove(PENDING_AUTH_STORAGE_KEY);
  } finally {
    if (callbackTab.id !== undefined) {
      await browser.tabs.remove(callbackTab.id).catch(() => undefined);
    }
  }
}

export async function signOut(): Promise<AuthStatus> {
  const key = (await listAccounts()).activeKey;
  if (key) await removeAccount(key);
  return getAuthStatus();
}

export async function getCurrentAccessToken(): Promise<string> {
  const before = (await listAccounts()).activeKey;
  const token = await getUsableToken();
  if (before !== (await listAccounts()).activeKey)
    throw new Error("The active account changed.");

  if (!token) {
    throw new Error("Your Microsoft session ended. Sign in again to continue.");
  }

  return token.access_token;
}

async function refreshAccessToken(previous: StoredToken): Promise<StoredToken> {
  const clientId = getClientId();

  if (!clientId || !previous.refresh_token) {
    throw new Error("Microsoft authentication is no longer configured.");
  }

  const response = await fetch(`${getAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: previous.refresh_token,
      scope: SCOPES.join(" "),
    }),
  });
  const body: unknown = await response.json();

  if (!response.ok) {
    if (isPermanentRefreshFailure(body)) {
      await markSignInRequired(
        accountIdentity(readUnverifiedIdTokenClaims(previous.id_token)),
      );
      throw new SignInRequiredError("Sign in again to sync this account.");
    }

    throw new Error(
      `Microsoft session refresh failed: ${getTokenErrorMessage(body)}`,
    );
  }

  const refreshed = tokenResponseSchema.parse(body);
  const storedToken: StoredToken = {
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? previous.refresh_token,
    id_token: refreshed.id_token ?? previous.id_token,
    expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  };
  await storeToken(
    storedToken,
    false,
    accountIdentity(readUnverifiedIdTokenClaims(previous.id_token)),
  );
  return storedToken;
}

function isPermanentRefreshFailure(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;

  const candidate = body as Record<string, unknown>;
  const code = candidate.error;
  const description = candidate.error_description;
  return (
    code === "invalid_grant" ||
    code === "interaction_required" ||
    (typeof description === "string" && description.includes("AADSTS90023"))
  );
}

function getTokenErrorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "Unknown response";
  }

  const candidate = body as Record<string, unknown>;
  const description = candidate.error_description;
  const error = candidate.error;

  if (typeof description === "string") {
    return description;
  }

  return typeof error === "string" ? error : "Unknown response";
}

export async function hasPendingAuthorizationCallback(): Promise<boolean> {
  const saved = await browser.storage.local.get(PENDING_AUTH_STORAGE_KEY);
  const pending = saved[PENDING_AUTH_STORAGE_KEY] as
    PendingAuthorization | undefined;
  if (!pending) return false;
  return (await browser.tabs.query({})).some((tab) =>
    tab.url?.startsWith(pending.redirectUri),
  );
}
