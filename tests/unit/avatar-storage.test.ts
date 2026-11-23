import { beforeEach, expect, test, vi } from "vitest";
import { defaultAccountSettings } from "@onedrop/core/domain/settings";
import { defaultAccountAvatar } from "@onedrop/core/domain/account-avatar";
vi.mock("@onedrop/onedrive/infrastructure/onedrive/app-folder", () => ({
  verifyAppFolderWithAccessToken: async () => ({ id: "root", name: "OneDrop" }),
}));
import {
  readAccountAvatarWithAccessToken,
  saveAccountAvatarWithAccessToken,
  saveAccountSettingsWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/settings";
let avatar: unknown;
beforeEach(() => {
  avatar = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://download.example/avatar") {
        expect(init).toMatchObject({ credentials: "omit" });
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Response.json(avatar);
      }
      if (init?.method === "PUT") {
        if (
          url.includes("avatar.json") ||
          url.includes("/items/avatar/content")
        )
          avatar = JSON.parse(init.body as string);
        return Response.json({ id: "saved" });
      }
      if (url.includes("settings/avatar.json"))
        return avatar === undefined
          ? new Response(null, { status: 404 })
          : Response.json({
              id: "avatar",
              eTag: "v1",
              "@microsoft.graph.downloadUrl": "https://download.example/avatar",
            });
      if (url.includes("settings/account.json"))
        return new Response(null, { status: 404 });
      return Response.json({ id: "folder", eTag: "v1" });
    }),
  );
});
test("missing avatar defaults, independent document survives legacy settings writes, and reset syncs to another client", async () => {
  expect(await readAccountAvatarWithAccessToken("token")).toEqual(
    defaultAccountAvatar(),
  );
  const chosen = {
    schemaVersion: 1 as const,
    dataUrl: "data:image/jpeg;base64,/9j/AA==",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
  await saveAccountAvatarWithAccessToken("token", chosen);
  expect(await readAccountAvatarWithAccessToken("second-client-token")).toEqual(
    chosen,
  );
  await saveAccountSettingsWithAccessToken(
    "old-client-token",
    defaultAccountSettings(),
  );
  expect(await readAccountAvatarWithAccessToken("token")).toEqual(chosen);
  await saveAccountAvatarWithAccessToken("token", { ...chosen, dataUrl: null });
  expect(
    (await readAccountAvatarWithAccessToken("second-client-token")).dataUrl,
  ).toBeNull();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, init]) =>
          String(url).includes("/items/avatar/content") &&
          new Headers(init?.headers).get("If-Match") === "v1",
      ),
  ).toBe(true);
});
test("invalid remote image fails validation rather than replacing local data or following an external image URL", async () => {
  avatar = {
    schemaVersion: 1,
    dataUrl: "https://tracker.example/image.svg",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
  await expect(readAccountAvatarWithAccessToken("token")).rejects.toThrow();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) =>
        String(url).startsWith("https://tracker.example"),
      ),
  ).toBe(false);
});
