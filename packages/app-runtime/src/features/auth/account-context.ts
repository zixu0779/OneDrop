let scope = "signed-out";
let closed = false;
export function configureAccountContext(value: string): void {
  scope = value;
  closed = false;
}
export function currentAccountScope(): string {
  return scope;
}
export function closeAccountContext(): void {
  closed = true;
}
export function assertAccountContext(expected = scope): void {
  if (closed || expected !== scope)
    throw new Error("The active account changed. Reopen OneDrop to continue.");
}
export function accountStorageKey(key: string): string {
  return `onedrop.edge.${scope}.${key}`;
}
