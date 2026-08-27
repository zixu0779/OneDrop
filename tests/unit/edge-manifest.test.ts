import { describe, expect, it } from "vitest";

import { createEdgeManifest } from "../../wxt.config";

describe("universal Edge package manifest", () => {
  it("keeps the fixed extension ID key in development", () => {
    expect(createEdgeManifest(true, "development-public-key")).toEqual(
      expect.objectContaining({ key: "development-public-key" }),
    );
  });

  it("keeps the fixed extension ID key in GitHub release builds", () => {
    expect(createEdgeManifest(true, "development-public-key")).toEqual(
      expect.objectContaining({ key: "development-public-key" }),
    );
  });

  it("omits the development key from Partner Center store builds", () => {
    expect(
      createEdgeManifest(false, "development-public-key"),
    ).not.toHaveProperty("key");
  });

  it("contains the permissions and hosts required across Edge platforms", () => {
    const manifest = createEdgeManifest(false);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["downloads", "identity", "sidePanel", "tabs"]),
    );
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "https://graph.microsoft.com/*",
        "https://*.files.1drv.com/*",
        "https://*.sharepoint.com/*",
      ]),
    );
  });
});
