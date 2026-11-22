export type LocalAccount = {
  key: string;
  displayName?: string | undefined;
  username?: string | undefined;
  lastUsedAt: number;
  signInRequired: boolean;
};

export type LocalAccounts = {
  activeKey?: string | undefined;
  accounts: LocalAccount[];
};

export const MAX_LOCAL_ACCOUNTS = 3;

// Identity is issuer + subject, never a mutable email or display name.
export function accountIdentity(claims: {
  iss?: string | undefined;
  sub?: string | undefined;
}): string {
  if (!claims.iss || !claims.sub)
    throw new Error("Microsoft account identity is unavailable.");
  return JSON.stringify([claims.iss, claims.sub]);
}

export async function accountStorageScope(key: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
