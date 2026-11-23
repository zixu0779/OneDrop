// @vitest-environment node
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const { plugin } = vi.hoisted(() => ({
  plugin: {
    getAccessToken: vi.fn(),
    status: vi.fn(),
    download: vi.fn(),
    signOut: vi.fn(),
  },
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => plugin }));
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());
async function openAccount(key: string) {
  const session = await import("@onedrop/native-runtime/account-session");
  const scope = await session.initializeAccountSession(key);
  const storage =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  storage.configureNativeDatabase(scope);
  return { session, storage, db: storage.oneDropDatabase, scope };
}
test("A to B to A keeps queues and caches separate and preserves unassigned data", async () => {
  const legacyModule =
    await import("@onedrop/web-storage/infrastructure/indexed-db/database");
  const legacy = new legacyModule.OneDropDatabase();
  const pending = {
    id: "legacy",
    createdAt: "2026-11-22",
    text: "Unassigned text",
    status: "send-failed" as const,
  };
  await legacy.pendingTexts.put(pending);
  const transfer = {
    id: "file-A",
    createdAt: "now",
    name: "kept.txt",
    mimeType: "text/plain",
    size: 4,
    lastModified: 0,
    blob: new Blob(["kept"]),
    isImage: false,
    status: "upload-failed" as const,
  };
  await legacy.pendingTransfers.put({ ...transfer, id: "legacy-file" });
  const a = await openAccount("issuer:account-A");
  await a.db.pendingTexts.put({ ...pending, id: "A", text: "A only" });
  await a.db.monthCache.put({
    month: "2026-11",
    itemId: "A",
    eTag: "a",
    cachedAt: "now",
    document: { schemaVersion: 1, month: "2026-11", messages: [] },
  });
  await a.db.pendingTransfers.put(transfer);
  await a.db.downloads.put({
    driveItemId: "download-A",
    downloadId: 1,
    cloudName: "kept.txt",
    createdAt: "now",
  });
  await a.db.attachmentCache.put({
    driveItemId: "image-A",
    name: "kept.txt",
    mimeType: "text/plain",
    size: 4,
    blob: transfer.blob,
    cachedAt: "now",
  });
  const originalDb = a.db;
  a.session.closeAccountSession();
  expect(() => a.session.scopedLocalKey("queue")).toThrow();
  vi.resetModules();
  const b = await openAccount("issuer:account-B");
  expect(await b.db.pendingTexts.count()).toBe(0);
  expect(await b.db.monthCache.count()).toBe(0);
  expect(await b.db.pendingTransfers.count()).toBe(0);
  expect(await b.db.downloads.count()).toBe(0);
  expect(await b.db.attachmentCache.count()).toBe(0);
  expect(
    await (await legacy.pendingTransfers.get("legacy-file"))?.blob.text(),
  ).toBe("kept");
  // A completion retaining its original DB cannot write into B.
  await originalDb.pendingTexts.put({ ...pending, id: "late-A" });
  expect(await b.db.pendingTexts.count()).toBe(0);
  expect(await legacy.pendingTexts.get("legacy")).toEqual(pending);
  b.db.close();
  vi.resetModules();
  const aAgain = await openAccount("issuer:account-A");
  expect(aAgain.scope).toBe(a.scope);
  expect(
    (await aAgain.db.pendingTexts.toArray()).map((item) => item.id).sort(),
  ).toEqual(["A", "late-A"]);
  expect(await aAgain.db.monthCache.get("2026-11")).toMatchObject({
    itemId: "A",
  });
  expect(
    await (await aAgain.db.pendingTransfers.get("file-A"))?.blob.text(),
  ).toBe("kept");
  expect(await aAgain.db.downloads.get("download-A")).toMatchObject({
    cloudName: "kept.txt",
  });
  expect(
    await (await aAgain.db.attachmentCache.get("image-A"))?.blob.text(),
  ).toBe("kept");
  expect(() => aAgain.storage.configureNativeDatabase("other")).toThrow(
    "new document",
  );
  await aAgain.db.delete();
  await legacy.delete();
  originalDb.close();
});
test.each(["different-account", undefined, ""])(
  "rejects a native token with mismatched or missing identity (%s)",
  async (accountKey) => {
    const session = await import("@onedrop/native-runtime/account-session");
    await session.initializeAccountSession("bound-account");
    plugin.getAccessToken.mockResolvedValue({
      accessToken: "synthetic",
      accountKey,
    });
    const { nativeAuth } = await import("@onedrop/native-runtime/native-auth");
    await expect(nativeAuth.getAccessToken()).rejects.toThrow();
  },
);
test("an in-flight token result cannot pass after sign-out; new requests are blocked", async () => {
  const session = await import("@onedrop/native-runtime/account-session");
  await session.initializeAccountSession("A");
  let complete!: (value: unknown) => void;
  plugin.getAccessToken.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const { nativeAuth } = await import("@onedrop/native-runtime/native-auth");
  const request = nativeAuth.getAccessToken();
  session.closeAccountSession();
  complete({ accessToken: "synthetic", accountKey: "A" });
  await expect(request).rejects.toThrow();
  await expect(nativeAuth.getAccessToken()).rejects.toThrow();
  expect(plugin.getAccessToken).toHaveBeenCalledTimes(1);
});
test("native downloads and progress are bound to the page account", async () => {
  const session = await import("@onedrop/native-runtime/account-session");
  const scope = await session.initializeAccountSession("A");
  const { nativeDownload } =
    await import("@onedrop/native-runtime/native-download");
  plugin.download.mockResolvedValue({ fileName: "file" });
  await nativeDownload.download({
    driveItemId: "item",
    fileName: "file",
    url: "https://example.org/file",
  });
  expect(plugin.download).toHaveBeenCalledWith({
    driveItemId: `${scope}:item`,
    fileName: "file",
    url: "https://example.org/file",
  });
  expect(session.unscopedDownloadId(`${scope}:item`)).toBe("item");
  expect(session.unscopedDownloadId("old-account:item")).toBeUndefined();
  expect(session.unscopedDownloadId("legacy-item")).toBeUndefined();
});

test("failed native sign-out leaves the current page session usable", async () => {
  const { session, db } = await openAccount("signout-A");
  const { nativeAuth } = await import("@onedrop/native-runtime/native-auth");
  plugin.signOut.mockRejectedValueOnce(new Error("Secure storage unavailable"));
  await expect(nativeAuth.signOut()).rejects.toThrow(
    "Secure storage unavailable",
  );
  expect(() => session.assertAccountSession("signout-A")).not.toThrow();
  db.close();
});
