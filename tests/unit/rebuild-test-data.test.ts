import { describe, expect, it, vi } from "vitest";

import { replaceTestFoldersTransaction } from "../../src/dev/rebuild-test-data";

describe("test data rebuild transaction", () => {
  it("restores original folders when fixture construction fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          value: [
            { id: "old-messages", name: "messages" },
            { id: "old-files", name: "files" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "old-messages" }))
      .mockResolvedValueOnce(Response.json({ id: "old-files" }))
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              id: "old-messages",
              name: ".onedrop-rebuild-backup-messages-00000000-0000-4000-8000-000000000001",
            },
            {
              id: "old-files",
              name: ".onedrop-rebuild-backup-files-00000000-0000-4000-8000-000000000002",
            },
            { id: "new-messages", name: "messages" },
            { id: "new-files", name: "files" },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ id: "old-files" }))
      .mockResolvedValueOnce(Response.json({ id: "old-messages" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");

    await expect(
      replaceTestFoldersTransaction("token", "root", async () => {
        throw new Error("File upload timed out");
      }),
    ).rejects.toThrow("File upload timed out");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/items/new-messages"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/items/old-messages"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "messages" }),
      }),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          String(url).includes("/items/old-messages") &&
          (options as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });
});
