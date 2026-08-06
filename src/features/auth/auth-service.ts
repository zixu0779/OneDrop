import type { AuthStatus } from "../../contracts/runtime-messages";
import { z } from "zod";
import { createPkcePair, createRandomBase64Url } from "./pkce";
import {
  readUnverifiedIdTokenClaims,
  tokenResponseSchema,
  type TokenResponse,
} from "./token";

const TOKEN_STORAGE_KEY = "onedrop.auth.token";
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
  const stored = await browser.storage.session.get(TOKEN_STORAGE_KEY);
  const value: unknown = stored[TOKEN_STORAGE_KEY];

  return zStoredToken.safeParse(value).data;
}

const zStoredToken = tokenResponseSchema.extend({
  expiresAt: z.iso.datetime(),
});

export async function getAuthStatus(): Promise<AuthStatus> {
  const redirectUri = getRedirectUri();

  if (!getClientId()) {
    return { state: "unconfigured", redirectUri };
  }

  const token = await readStoredToken();

  if (!token || Date.parse(token.expiresAt) <= Date.now()) {
    await browser.storage.session.remove(TOKEN_STORAGE_KEY);
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

  const authority = getAuthority();
  const redirectUri = getRedirectUri();
  const state = createRandomBase64Url();
  const { verifier, challenge } = await createPkcePair();
  const authorizeUrl = new URL(`${authority}/oauth2/v2.0/authorize`);

  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  }).toString();

  const callbackUrl = await browser.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });

  if (!callbackUrl) {
    throw new Error("Microsoft sign-in did not return a callback URL.");
  }

  const callback = new URL(callbackUrl);
  const authError = callback.searchParams.get("error_description");

  if (authError) {
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
    throw new Error(`Microsoft token exchange failed: ${message}`);
  }

  const token = tokenResponseSchema.parse(tokenBody);
  const storedToken: StoredToken = {
    ...token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
  };

  await browser.storage.session.set({ [TOKEN_STORAGE_KEY]: storedToken });
  return getAuthStatus();
}

export async function signOut(): Promise<AuthStatus> {
  await browser.storage.session.remove(TOKEN_STORAGE_KEY);
  return getAuthStatus();
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
