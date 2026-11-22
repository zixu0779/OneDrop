import { accountStorageScope } from "@onedrop/core/domain/local-account";
import {
  accountAvatarSchema,
  defaultAccountAvatar,
  type AccountAvatar,
} from "@onedrop/core/domain/account-avatar";
import { oneDropDatabase } from "@onedrop/web-storage/infrastructure/indexed-db/database";
export function avatarCacheKey() {
  return `${oneDropDatabase.name.replace(/^OneDrop\./u, "onedrop.")}.avatar.v1`;
}
function read(key: string): AccountAvatar {
  try {
    return accountAvatarSchema.parse(
      JSON.parse(localStorage.getItem(key) ?? "null"),
    );
  } catch {
    return defaultAccountAvatar();
  }
}
export function readCachedAvatar() {
  return read(avatarCacheKey());
}
export function cacheAvatar(avatar: AccountAvatar) {
  localStorage.setItem(
    avatarCacheKey(),
    JSON.stringify(accountAvatarSchema.parse(avatar)),
  );
  window.dispatchEvent(new Event("onedrop-avatar-updated"));
}
export async function readCachedAccountAvatar(key: string) {
  const platform = oneDropDatabase.name.startsWith("OneDrop.native.")
    ? "native"
    : "edge";
  return read(
    `onedrop.${platform}.${await accountStorageScope(key)}.avatar.v1`,
  );
}
