let identity: string | undefined;
let scope: string | undefined;
let closed = false;

export async function initializeAccountSession(
  accountKey?: string,
): Promise<string> {
  if (scope !== undefined)
    throw new Error("Account session is already initialized.");
  identity = accountKey;
  scope = accountKey
    ? Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(accountKey),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    : "signed-out";
  return scope;
}
export function assertAccountSession(accountKey?: string): void {
  if (
    closed ||
    scope === undefined ||
    (accountKey !== undefined && accountKey !== identity)
  ) {
    throw new Error(
      "The Microsoft account changed. Reopen OneDrop to continue.",
    );
  }
}
export function accountScope(): string {
  assertAccountSession();
  return scope!;
}
export function matchesAccount(accountKey?: string): boolean {
  return accountKey === identity;
}
export function closeAccountSession(): void {
  closed = true;
}
export function scopedLocalKey(key: string): string {
  return `onedrop.native.${accountScope()}.${key}`;
}
export function scopedDownloadId(id: string): string {
  return `${accountScope()}:${id}`;
}
export function unscopedDownloadId(id: string): string | undefined {
  const prefix = `${accountScope()}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}
