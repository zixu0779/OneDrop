import { afterEach, expect, it, vi } from "vitest";

import { listHistoryMonths } from "@onedrop/onedrive/infrastructure/onedrive/month-list";

afterEach(() => vi.unstubAllGlobals());

it("combines paginated source folders and archive-only months newest first", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/archive:"))
        return Response.json({
          value: [
            { name: "2024-10.json" },
            { name: "2026-01.json" },
            { name: "2023-01.json", folder: {} },
            { name: "2024-00.json" },
          ],
        });
      if (url.includes("/messages:"))
        return Response.json({
          value: [{ name: "2026-01", folder: {} }, { name: "2023-07" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
        });
      return Response.json({ value: [{ name: "2025-12", folder: {} }] });
    }),
  );
  expect(await listHistoryMonths("token")).toEqual([
    "2026-01",
    "2025-12",
    "2024-10",
  ]);
});

it("ends history discovery when neither directory exists", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  expect(await listHistoryMonths("token")).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects foreign pagination URLs before sending credentials", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      value: [],
      "@odata.nextLink": "https://untrusted.invalid/next",
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(listHistoryMonths("token")).rejects.toThrow(
    "invalid month pagination URL",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
