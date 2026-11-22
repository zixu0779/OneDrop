import { useCallback, useEffect, useRef, useState } from "react";
import {
  accountAvatarSchema,
  type AccountAvatar,
} from "@onedrop/core/domain/account-avatar";
import type {
  RuntimeRequest,
  RuntimeResponse,
} from "@onedrop/core/contracts/runtime-messages";
import {
  avatarCacheKey,
  cacheAvatar,
  readCachedAvatar,
} from "@onedrop/app-runtime/features/settings/avatar-cache";
import { prepareAccountAvatar } from "./account-avatar-image";

export function useAccountAvatar(
  request: (request: RuntimeRequest) => Promise<RuntimeResponse>,
) {
  const [avatar, setAvatar] = useState(readCachedAvatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryValue, setRetryValue] = useState<{ dataUrl: string | null }>();
  const mounted = useRef(true);
  const pending = useRef(false),
    revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const update = () => {
      revision.current++;
      setAvatar(readCachedAvatar());
    };
    const storage = (event: StorageEvent) => {
      if (event.key === avatarCacheKey()) update();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("onedrop-avatar-updated", update);
    return () => {
      mounted.current = false;
      revision.current++;
      window.removeEventListener("storage", storage);
      window.removeEventListener("onedrop-avatar-updated", update);
    };
  }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    setRetryValue(undefined);
    const current = ++revision.current;
    const owner = avatarCacheKey();
    try {
      const result = await request({ type: "settings/read-avatar" });
      if (
        current !== revision.current ||
        pending.current ||
        !mounted.current ||
        owner !== avatarCacheKey()
      )
        return;
      if (!result.ok) throw new Error(result.error);
      if (result.type !== "settings/avatar")
        throw new Error("The account avatar could not be read.");
      const next = accountAvatarSchema.parse(result.avatar);
      cacheAvatar(next);
      setAvatar(next);
      setError("");
    } catch (cause) {
      if (
        current === revision.current &&
        mounted.current &&
        owner === avatarCacheKey()
      )
        setError(
          cause instanceof Error
            ? cause.message
            : "The account avatar could not be synced.",
        );
    }
  }, [request]);
  async function save(create: () => Promise<string | null>) {
    if (pending.current) return;
    pending.current = true;
    const owner = avatarCacheKey();
    const stillCurrent = () => mounted.current && owner === avatarCacheKey();
    revision.current++;
    setBusy(true);
    setError("");
    setRetryValue(undefined);
    try {
      const dataUrl = await create();
      if (!stillCurrent()) return;
      setRetryValue({ dataUrl });
      const next: AccountAvatar = {
        schemaVersion: 1,
        dataUrl,
        updatedAt: new Date().toISOString(),
      };
      const result = await request({
        type: "settings/save-avatar",
        avatar: next,
      });
      if (!stillCurrent()) return;
      if (!result.ok) throw new Error(result.error);
      if (result.type !== "settings/avatar")
        throw new Error("The account avatar could not be saved.");
      const saved = accountAvatarSchema.parse(result.avatar);
      cacheAvatar(saved);
      setAvatar(saved);
      setRetryValue(undefined);
    } catch (cause) {
      if (!stillCurrent()) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "The account avatar could not be saved. Try again.",
      );
    } finally {
      pending.current = false;
      if (stillCurrent()) setBusy(false);
    }
  }
  return {
    avatar,
    busy,
    error,
    load,
    choose: (file: File) => save(() => prepareAccountAvatar(file)),
    reset: () => save(async () => null),
    retry: retryValue ? () => save(async () => retryValue.dataUrl) : undefined,
  };
}
