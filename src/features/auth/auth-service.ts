import type { AuthStatus } from "../../contracts/runtime-messages";
import { z } from "zod";
import { createPkcePair, createRandomBase64Url } from "./pkce";
import {
  readUnverifiedIdTokenClaims,
  tokenResponseSchema,
  type TokenResponse,
} from "./token";

const TOKEN_STORAGE_KEY = "onedrop.auth.token";
const EXPIRY_SKEW_MS = 60_000;
const REDIRECT_PATH = "auth";
const SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Files.ReadWrite.AppFolder",
] as const;

type StoredToken = TokenResponse & {
  expiresAt: string;
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
  return browser.identity.getRedirectURL(REDIRECT_PATH);
}

async function readStoredToken(): Promise<StoredToken | undefined> {
  const stored = await browser.storage.local.get(TOKEN_STORAGE_KEY);
  const value: unknown = stored[TOKEN_STORAGE_KEY];

  const parsed = zStoredToken.safeParse(value).data;

  if (parsed) return parsed;

  // Migrate a token created by an earlier validation build while the current
  // Edge session is still alive.
  const sessionStored = await browser.storage.session.get(TOKEN_STORAGE_KEY);
  const sessionToken = zStoredToken.safeParse(
    sessionStored[TOKEN_STORAGE_KEY],
  ).data;

  if (sessionToken) {
    await storeToken(sessionToken);
    await browser.storage.session.remove(TOKEN_STORAGE_KEY);
  }

  return sessionToken;
}

const zStoredToken = tokenResponseSchema.extend({
  expiresAt: z.iso.datetime(),
});

let refreshInFlight: Promise<StoredToken | undefined> | undefined;

class SignInRequiredError extends Error {}

async function storeToken(token: StoredToken): Promise<void> {
  await browser.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
}

async function removeStoredToken(): Promise<void> {
  await Promise.all([
    browser.storage.local.remove(TOKEN_STORAGE_KEY),
    browser.storage.session.remove(TOKEN_STORAGE_KEY),
  ]);
}

function isAccessTokenUsable(token: StoredToken): boolean {
  return Date.parse(token.expiresAt) > Date.now() + EXPIRY_SKEW_MS;
}

async function getUsableToken(): Promise<StoredToken | undefined> {
  const token = await readStoredToken();

  if (!token || isAccessTokenUsable(token)) return token;

  if (!token.refresh_token) {
    await removeStoredToken();
    return undefined;
  }

  refreshInFlight ??= refreshAccessToken(token)
    .catch((error: unknown) => {
      if (error instanceof SignInRequiredError) return undefined;
      throw error;
    })
    .finally(() => {
      refreshInFlight = undefined;
    });

  return refreshInFlight;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const redirectUri = getRedirectUri();

  if (!getClientId()) {
    return { state: "unconfigured", redirectUri };
  }

  const token = await getUsableToken();

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

export async function signIn(): Promise<AuthStatus> {
  const clientId = getClientId();

  if (!clientId) {
    throw new Error("Microsoft Entra Client ID is not configured.");
  }

  await acquireAuthorizationCodeToken({ interactive: true });
  await browser.storage.session.remove(TOKEN_STORAGE_KEY);
  return getAuthStatus();
}

async function acquireAuthorizationCodeToken(options: {
  interactive: boolean;
  previous?: StoredToken;
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
  try {
    callbackUrl = await browser.identity.launchWebAuthFlow({
      url: authorizeUrl.toString(),
      interactive: options.interactive,
    });
  } catch (cause) {
    if (!options.interactive) {
      throw new SignInRequiredError(
        "The Microsoft browser session cannot renew OneDrop silently.",
        { cause },
      );
    }
    throw cause;
  }

  if (!callbackUrl) {
    if (!options.interactive) {
      throw new SignInRequiredError("The Microsoft browser session has ended.");
    }
    throw new Error("Microsoft sign-in did not return a callback URL.");
  }

  const callback = new URL(callbackUrl);
  const authError = callback.searchParams.get("error_description");

  if (authError) {
    if (!options.interactive) {
      throw new SignInRequiredError(authError);
    }
    throw new Error(authError);
  }

  if (callback.searchParams.get("state") !== state) {
    throw new Error("Microsoft sign-in state validation failed.");
  }

  const code = callback.searchParams.get("code");

  if (!code) {
    throw new Error("Microsoft sign-in did not return an authorization code.");
  }

  const tokenResponse = await fetch(`${authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: SCOPES.join(" "),
    }),
  });

  const tokenBody: unknown = await tokenResponse.json();

  if (!tokenResponse.ok) {
    const message = getTokenErrorMessage(tokenBody);
    if (!options.interactive && isPermanentRefreshFailure(tokenBody)) {
      throw new SignInRequiredError(message);
    }
    throw new Error(`Microsoft token exchange failed: ${message}`);
  }

  const token = tokenResponseSchema.parse(tokenBody);
  const storedToken: StoredToken = {
    ...token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  };

  await storeToken(storedToken);
  return storedToken;
}

export async function signOut(): Promise<AuthStatus> {
  await removeStoredToken();
  return getAuthStatus();
}

export async function getCurrentAccessToken(): Promise<string> {
  const token = await getUsableToken();

  if (!token) {
    throw new Error("Your Microsoft session ended. Sign in again to continue.");
  }

  return token.access_token;
}

async function refreshAccessToken(previous: StoredToken): Promise<StoredToken> {
  const clientId = getClientId();

  if (!clientId || !previous.refresh_token) {
    await removeStoredToken();
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
      try {
        return await acquireAuthorizationCodeToken({
          interactive: false,
          previous,
        });
      } catch (error) {
        if (error instanceof SignInRequiredError) {
          await removeStoredToken();
        }
        throw error;
      }
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
  await storeToken(storedToken);
  return storedToken;
}

function isPermanentRefreshFailure(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;

  const code = (body as Record<string, unknown>).error;
  return code === "invalid_grant" || code === "interaction_required";
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
