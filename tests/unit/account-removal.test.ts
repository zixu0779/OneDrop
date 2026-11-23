import "fake-indexeddb/auto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import Dexie from "dexie";
vi.mock("@onedrop/core/domain/local-account", () => ({
  accountStorageScope: async (key: string) => key,
}));
import {
  configureExtensionDatabase,
  oneDropDatabase,
} from "@onedrop/web-storage/infrastructure/indexed-db/database";
beforeEach(async () => {
  oneDropDatabase.close();
  await Promise.all(
    ["OneDrop", "OneDrop.edge.A", "OneDrop.edge.B"].map((name) =>
      Dexie.delete(name),
    ),
  );
  localStorage.clear();
  configureExtensionDatabase("A");
});
afterEach(() => oneDropDatabase.close());
test("account pause marks only running IDs, claims once across contexts, and never resumes cancellation", async () => {
  const { pauseAccountTransfers, claimPausedTransfer, claimPausedText } =
    await import("@onedrop/web-storage/infrastructure/indexed-db/account-data");
  const file = {
    createdAt: "2026-07-10T00:00:00Z",
    name: "file.txt",
    mimeType: "text/plain",
    size: 4,
    lastModified: 1,
    blob: new Blob(["data"]),
    isImage: false,
    status: "uploading" as const,
  };
  await oneDropDatabase.pendingTransfers.bulkPut([
    { ...file, id: "running" },
    { ...file, id: "old-interrupted" },
  ]);
  await pauseAccountTransfers(["running"]);
  expect(
    (await oneDropDatabase.pendingTransfers.get("old-interrupted"))
      ?.pausedForAccountChange,
  ).toBeUndefined();
  expect(
    await Promise.all([
      claimPausedTransfer("running"),
      claimPausedTransfer("running"),
    ]),
  ).toEqual([true, false]);
  await oneDropDatabase.pendingTransfers.update("running", {
    pausedForAccountChange: true,
    status: "cancelled",
  });
  expect(await claimPausedTransfer("running")).toBe(false);
  await oneDropDatabase.pendingTexts.put({
    id: "text",
    createdAt: file.createdAt,
    text: "keep",
    status: "send-failed",
    pausedForAccountChange: true,
  });
  expect(
    await Promise.all([claimPausedText("text"), claimPausedText("text")]),
  ).toEqual([true, false]);
});

test("pending deletion rolls both stores back if a local delete fails", async () => {
  const { deletePendingMessage } =
    await import("@onedrop/web-storage/infrastructure/indexed-db/account-data");
  const id = "atomic-delete";
  await oneDropDatabase.pendingTexts.put({
    id,
    text: "keep",
    createdAt: "now",
    status: "send-failed",
  });
  await oneDropDatabase.pendingTransfers.put({
    id,
    createdAt: "now",
    name: "keep.txt",
    mimeType: "text/plain",
    size: 4,
    lastModified: 0,
    blob: new Blob(["keep"]),
    isImage: false,
    status: "upload-failed",
  });
  const fail = () => {
    throw new Error("Local storage failed");
  };
  oneDropDatabase.pendingTransfers.hook("deleting", fail);
  await expect(deletePendingMessage(id)).rejects.toThrow(
    "Local storage failed",
  );
  expect(await oneDropDatabase.pendingTexts.get(id)).toBeDefined();
  expect(await oneDropDatabase.pendingTransfers.get(id)).toBeDefined();
  oneDropDatabase.pendingTransfers.hook("deleting").unsubscribe(fail);
  await deletePendingMessage(id);
  expect(await oneDropDatabase.pendingTexts.get(id)).toBeUndefined();
  expect(await oneDropDatabase.pendingTransfers.get(id)).toBeUndefined();
});
