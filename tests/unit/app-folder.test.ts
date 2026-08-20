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

  it("returns an existing explicit OneDrop folder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: "drive-item-id",
          name: "OneDrop",
          webUrl: "https://example.com/Apps/OneDrop",
        }),
      ),
    );

    await expect(
      verifyAppFolderWithAccessToken("existing-token"),
    ).resolves.toEqual({
      id: "drive-item-id",
      name: "OneDrop",
      webUrl: "https://example.com/Apps/OneDrop",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/drive/root:/Apps/OneDrop"),
      expect.any(Object),
    );
  });

  it("shares provisioning between callers with and without abort signals", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "drive-item-id", name: "OneDrop" }),
        ),
    );

    const plain = verifyAppFolderWithAccessToken("shared-token");
    const cancellable = verifyAppFolderWithAccessToken(
      "shared-token",
      controller.signal,
    );

    await expect(Promise.all([plain, cancellable])).resolves.toEqual([
      { id: "drive-item-id", name: "OneDrop" },
      { id: "drive-item-id", name: "OneDrop" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels only one caller while shared provisioning continues", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const controller = new AbortController();

    const shared = verifyAppFolderWithAccessToken("abort-token");
    const cancelled = verifyAppFolderWithAccessToken(
      "abort-token",
      controller.signal,
    );
    const rejection = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;

    resolveFetch(Response.json({ id: "drive-item-id", name: "OneDrop" }));
    await expect(shared).resolves.toEqual({
      id: "drive-item-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates Apps and OneDrop when the explicit path is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ id: "apps-id", name: "Apps" }))
        .mockResolvedValueOnce(
          Response.json({ id: "onedrop-id", name: "OneDrop" }),
        ),
    );

    await expect(
      verifyAppFolderWithAccessToken("create-token"),
    ).resolves.toEqual({
      id: "onedrop-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/me/drive/root/children"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Apps",
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/me/drive/items/apps-id/children"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "OneDrop",
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      }),
    );
  });

  it("reuses Apps when another caller created it first", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 409 }))
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "apps-id", name: "Apps" }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ id: "onedrop-id", name: "OneDrop" }),
        ),
    );

    await expect(
      verifyAppFolderWithAccessToken("apps-conflict-token"),
    ).resolves.toEqual({
      id: "onedrop-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/me/drive/root/children?$select=id,name,webUrl"),
      expect.any(Object),
    );
  });

  it("reuses OneDrop when another caller created it first", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ id: "apps-id", name: "Apps" }))
        .mockResolvedValueOnce(new Response(null, { status: 409 }))
        .mockResolvedValueOnce(
          Response.json({
            value: [{ id: "onedrop-id", name: "OneDrop" }],
          }),
        ),
    );

    await expect(
      verifyAppFolderWithAccessToken("onedrop-conflict-token"),
    ).resolves.toEqual({
      id: "onedrop-id",
      name: "OneDrop",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining(
        "/me/drive/items/apps-id/children?$select=id,name,webUrl",
      ),
      expect.any(Object),
    );
  });

  it("reports a non-conflict folder creation failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: "Access denied." } },
            { status: 403 },
          ),
        ),
    );

    await expect(
      verifyAppFolderWithAccessToken("denied-token"),
    ).rejects.toThrow("OneDrive folder initialization failed: Access denied.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
