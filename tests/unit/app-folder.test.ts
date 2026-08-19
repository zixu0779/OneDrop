import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseAppFolder,
  verifyAppFolderWithAccessToken,
} from "@onedrop/onedrive/infrastructure/onedrive/app-folder";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseAppFolder", () => {
  it("accepts a valid App Folder response without a specialFolder facet", () => {
    expect(
      parseAppFolder({
        id: "drive-item-id",
        name: "OneDrop",
        webUrl: "https://example.com/Apps/OneDrop",
      }),
    ).toEqual({
      id: "drive-item-id",
      name: "OneDrop",
      webUrl: "https://example.com/Apps/OneDrop",
    });
  });

  it("accepts the documented approot facet", () => {
    expect(
      parseAppFolder({
        id: "drive-item-id",
        name: "OneDrop",
        specialFolder: { name: "approot" },
      }),
    ).toEqual({
      id: "drive-item-id",
      name: "OneDrop",
    });
  });

  it("retries a transient missing App Folder while OneDrive provisions it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: "The resource could not be found." } },
            { status: 404 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: "The resource could not be found." } },
            { status: 404 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ id: "drive-item-id", name: "OneDrop" }),
        ),
    );

    const resultPromise = verifyAppFolderWithAccessToken("access-token");
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      id: "drive-item-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("provisions the App Folder through a temporary path when the root stays missing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          Response.json({
            id: "probe-item",
            parentReference: { id: "drive-item-id" },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );

    const resultPromise = verifyAppFolderWithAccessToken("access-token");
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      id: "drive-item-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("/special/approot:/.onedrop-app-folder-probe-"),
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("/items/probe-item"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
