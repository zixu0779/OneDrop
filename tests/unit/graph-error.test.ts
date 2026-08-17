import { describe, expect, it } from "vitest";

import { readGraphError } from "@onedrop/onedrive/infrastructure/graph/graph-error";

describe("readGraphError", () => {
  it("extracts the Microsoft Graph error message", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "accessDenied", message: "Denied" } }),
      { status: 403, statusText: "Forbidden" },
    );

    await expect(readGraphError(response)).resolves.toBe("Denied");
  });

  it("falls back to the HTTP status text", async () => {
    const response = new Response("not-json", {
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(readGraphError(response)).resolves.toBe(
      "Internal Server Error",
    );
  });
});
