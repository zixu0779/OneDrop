import { afterEach, expect, test, vi } from "vitest";
vi.mock("@onedrop/web-storage/infrastructure/indexed-db/sync-cache", () => ({
  getMonthCache: vi.fn(),
  deleteMonthCache: vi.fn(),
  putMonthCache: vi.fn(),
}));
vi.mock("@onedrop/app-runtime/features/auth/auth-service", () => ({
  getCurrentAccessToken: vi.fn(),
}));
import { readGraphContent } from "@onedrop/onedrive/infrastructure/graph/graph-content";
import { readMonthSnapshot } from "@onedrop/onedrive/infrastructure/onedrive/month-reader";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const metadataUrl = "https://graph.microsoft.com/v1.0/me/drive/items/item";
const downloadUrl =
  "https://my.microsoftpersonalcontent.com/download?signature=synthetic";
test("reads full metadata then downloads without bearer or cookies", async () => {
  const content = new Response("bytes", { headers: { etag: "download-etag" } });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ "@microsoft.graph.downloadUrl": downloadUrl }),
    )
    .mockResolvedValueOnce(content);
  vi.stubGlobal("fetch", fetch);
  expect(await readGraphContent(metadataUrl, "synthetic-token")).toBe(content);
  expect(fetch.mock.calls).toEqual([
    [metadataUrl, { headers: { Authorization: "Bearer synthetic-token" } }],
    [downloadUrl, { credentials: "omit" }],
  ]);
  expect(content.headers.get("etag")).toBe("download-etag");
});
test.each([404, 401, 503])(
  "preserves metadata HTTP %s for caller handling",
  async (status) => {
    const response = new Response("failure", { status });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    expect(await readGraphContent(metadataUrl, "synthetic-token")).toBe(
      response,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
test.each([
  undefined,
  "http://example.org/file",
  "https://user:password@example.org/file",
  "invalid",
])(
  "rejects invalid download metadata without another request (%s)",
  async (url) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ "@microsoft.graph.downloadUrl": url }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      readGraphContent(metadataUrl, "synthetic-token"),
    ).rejects.toThrow("valid download URL");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
test("never sends bearer to a non-Graph metadata endpoint", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    readGraphContent("https://example.org/item", "synthetic-token"),
  ).rejects.toThrow("metadata URL");
  expect(fetch).not.toHaveBeenCalled();
});
test.each([false, true])(
  "month reads use the real metadata path and retain corrupt-document handling (%s)",
  async (corrupt) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          value: [{ id: "item", name: "0001.json", eTag: "original-etag" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ "@microsoft.graph.downloadUrl": downloadUrl }),
      )
      .mockResolvedValueOnce(
        new Response(
          corrupt
            ? "invalid JSON"
            : JSON.stringify({
                schemaVersion: 1,
                month: "2026-11",
                messages: [],
              }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = await readMonthSnapshot(
      "2026-11",
      "synthetic-token",
      true,
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(metadataUrl);
    expect(fetch.mock.calls[2]).toEqual([downloadUrl, { credentials: "omit" }]);
    if (corrupt)
      expect(snapshot.corruptFiles).toEqual([
        { itemId: "item", name: "0001.json" },
      ]);
    else
      expect(snapshot).toMatchObject({
        state: "loaded",
        eTag: "original-etag",
        document: { messages: [] },
      });
  },
);

test("path-based settings metadata keeps a missing file as default settings", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
  const { readAccountSettingsWithAccessToken } =
    await import("@onedrop/onedrive/infrastructure/onedrive/settings");
  const { defaultAccountSettings } =
    await import("@onedrop/core/domain/settings");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  expect(await readAccountSettingsWithAccessToken("synthetic-token")).toEqual(
    defaultAccountSettings(),
  );
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://graph.microsoft.com/v1.0/me/drive/root:/Apps/OneDrop/settings/account.json",
    { headers: { Authorization: "Bearer synthetic-token" } },
  );
});

test.each([
  "deleted",
  "missing",
  "invalid-json",
  "invalid-schema",
  "wrong-month",
])(
  "real month-to-tombstone reads preserve %s semantics and credential boundaries",
  async (scenario) => {
    const message = {
      schemaVersion: 1,
      id: "01989f5e-7700-7000-8000-000000000001",
      type: "text",
      text: "deleted message",
      createdAt: "2026-11-01T00:00:00Z",
    };
    const tombstoneMetadata =
      "https://graph.microsoft.com/v1.0/me/drive/root:/Apps/OneDrop/tombstones/2026-11.json";
    const tombstoneDownload =
      "https://my.microsoftpersonalcontent.com/tombstones?signature=synthetic";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          value: [{ id: "item", name: "0001.json", eTag: "original-etag" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ "@microsoft.graph.downloadUrl": downloadUrl }),
      )
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: 1,
          month: "2026-11",
          messages: [message],
        }),
      )
      .mockResolvedValueOnce(
        scenario === "missing"
          ? new Response(null, { status: 404 })
          : Response.json({
              "@microsoft.graph.downloadUrl": tombstoneDownload,
            }),
      )
      .mockResolvedValueOnce(
        new Response(
          scenario === "invalid-json"
            ? "invalid JSON"
            : JSON.stringify({
                schemaVersion: 1,
                month: scenario === "wrong-month" ? "2026-10" : "2026-11",
                tombstones:
                  scenario === "invalid-schema"
                    ? [{}]
                    : [
                        {
                          schemaVersion: 1,
                          messageId: message.id,
                          originalMonth: "2026-11",
                          deletedAt: "2026-11-02T00:00:00Z",
                        },
                      ],
              }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const result = readMonthSnapshot("2026-11", "synthetic-token", true);
    if (scenario === "deleted" || scenario === "missing") {
      expect(await result).toMatchObject({
        state: "loaded",
        document: { messages: scenario === "missing" ? [message] : [] },
      });
    } else if (scenario === "wrong-month") {
      await expect(result).rejects.toThrow("another month");
    } else {
      await expect(result).rejects.toThrow();
    }
    expect(fetch.mock.calls[3]).toEqual([
      tombstoneMetadata,
      { headers: { Authorization: "Bearer synthetic-token" } },
    ]);
    expect(fetch.mock.calls[2]).toEqual([downloadUrl, { credentials: "omit" }]);
    if (scenario === "missing") expect(fetch).toHaveBeenCalledTimes(4);
    else
      expect(fetch.mock.calls[4]).toEqual([
        tombstoneDownload,
        { credentials: "omit" },
      ]);
  },
);
