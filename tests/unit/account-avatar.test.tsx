import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  accountAvatarSchema,
  defaultAccountAvatar,
} from "@onedrop/core/domain/account-avatar";
import {
  configureExtensionDatabase,
  oneDropDatabase,
} from "@onedrop/web-storage/infrastructure/indexed-db/database";
import {
  avatarCacheKey,
  cacheAvatar,
  readCachedAvatar,
  readCachedAccountAvatar,
} from "@onedrop/app-runtime/features/settings/avatar-cache";
import type { RuntimeResponse } from "@onedrop/core/contracts/runtime-messages";
const image = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../packages/ui/src/account-avatar-image", () => ({
  prepareAccountAvatar: image.prepare,
}));
vi.mock("@onedrop/core/domain/local-account", () => ({
  accountStorageScope: async (key: string) => key,
}));
import { useAccountAvatar } from "../../packages/ui/src/useAccountAvatar";
const old = {
  schemaVersion: 1 as const,
  dataUrl: "data:image/jpeg;base64,/9j/AA==",
  updatedAt: "2026-11-20T00:00:00.000Z",
};
beforeEach(() => {
  localStorage.clear();
  oneDropDatabase.close();
  configureExtensionDatabase("A");
  image.prepare.mockReset();
  image.prepare.mockResolvedValue(old.dataUrl);
});
afterEach(() => {
  cleanup();
  oneDropDatabase.close();
});
test("avatar schema rejects external/SVG/oversized data and accepts explicit reset", () => {
  for (const dataUrl of [
    "https://example.com/a.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64," + "A".repeat(128 * 1024),
  ])
    expect(accountAvatarSchema.safeParse({ ...old, dataUrl }).success).toBe(
      false,
    );
  expect(
    accountAvatarSchema.parse({ ...old, dataUrl: null }).dataUrl,
  ).toBeNull();
});
test("failed read/save keeps cached avatar and retry persists explicit reset", async () => {
  cacheAvatar(old);
  const request = vi.fn().mockResolvedValue({ ok: false, error: "Offline" });
  const { result } = renderHook(() => useAccountAvatar(request));
  await act(() => result.current.load());
  expect(result.current.avatar).toEqual(old);
  await act(() => result.current.reset());
  expect(result.current.avatar).toEqual(old);
  expect(result.current.retry).toBeTypeOf("function");
  request.mockImplementation(async (command) => ({
    ok: true,
    type: "settings/avatar",
    avatar: command.avatar,
  }));
  await act(() => result.current.retry!());
  expect(readCachedAvatar().dataUrl).toBeNull();
  expect(result.current.error).toBe("");
});
test("late read cannot revive an avatar after reset; next successful read clears read errors", async () => {
  cacheAvatar(old);
  let finish!: (value: RuntimeResponse) => void;
  const request = vi.fn(async (command): Promise<RuntimeResponse> =>
    command.type === "settings/read-avatar"
      ? new Promise<RuntimeResponse>((resolve) => {
          finish = resolve;
        })
      : { ok: true, type: "settings/avatar", avatar: command.avatar },
  );
  const { result } = renderHook(() => useAccountAvatar(request));
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.load();
  });
  await act(() => result.current.reset());
  await act(async () => {
    finish({ ok: true, type: "settings/avatar", avatar: old });
    await loading;
  });
  expect(readCachedAvatar().dataUrl).toBeNull();
  request.mockResolvedValueOnce({ ok: false, error: "Offline" });
  await act(() => result.current.load());
  request.mockResolvedValueOnce({
    ok: true,
    type: "settings/avatar",
    avatar: defaultAccountAvatar(),
  });
  await act(() => result.current.load());
  expect(result.current.error).toBe("");
});
test("account switch during decode prevents submission and late save cannot write another scope", async () => {
  let decoded!: (value: string) => void;
  image.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        decoded = resolve;
      }),
  );
  const request = vi.fn();
  const { result, unmount } = renderHook(() => useAccountAvatar(request));
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.choose(new File([], "avatar.jpg"));
  });
  configureExtensionDatabase("B");
  await act(async () => {
    decoded(old.dataUrl);
    await saving;
  });
  expect(request).not.toHaveBeenCalled();
  expect(readCachedAvatar().dataUrl).toBeNull();
  unmount();
  configureExtensionDatabase("A");
  let complete!: (value: RuntimeResponse) => void;
  const pending = vi.fn(
    () =>
      new Promise<RuntimeResponse>((resolve) => {
        complete = resolve;
      }),
  );
  const second = renderHook(() => useAccountAvatar(pending));
  act(() => {
    saving = second.result.current.reset();
  });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  second.unmount();
  configureExtensionDatabase("B");
  complete({
    ok: true,
    type: "settings/avatar",
    avatar: { ...old, dataUrl: null },
  });
  await saving;
  expect(localStorage.getItem(avatarCacheKey())).toBeNull();
});
test("inactive lookup reads only its retained local avatar cache", async () => {
  cacheAvatar(old);
  configureExtensionDatabase("B");
  cacheAvatar(defaultAccountAvatar());
  expect((await readCachedAccountAvatar("A")).dataUrl).toBe(old.dataUrl);
  expect(readCachedAvatar().dataUrl).toBeNull();
});

test("successful reload discards an obsolete failed-save retry before a later read failure", async () => {
  cacheAvatar(old);
  const request = vi
    .fn()
    .mockResolvedValue({ ok: false, error: "Save failed" });
  const { result } = renderHook(() => useAccountAvatar(request));
  await act(() => result.current.reset());
  expect(result.current.retry).toBeTypeOf("function");
  request.mockResolvedValueOnce({
    ok: true,
    type: "settings/avatar",
    avatar: old,
  });
  await act(() => result.current.load());
  request.mockResolvedValueOnce({ ok: false, error: "Read failed" });
  await act(() => result.current.load());
  expect(result.current.retry).toBeUndefined();
  expect(result.current.avatar).toEqual(old);
  expect(
    request.mock.calls.filter(
      ([command]) => command.type === "settings/save-avatar",
    ),
  ).toHaveLength(1);
});
