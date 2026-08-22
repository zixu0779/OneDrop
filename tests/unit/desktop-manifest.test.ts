import { describe, expect, it } from "vitest";

import { createDesktopManifest } from "../../wxt.config";

describe("desktop Edge manifest", () => {
  it("keeps the fixed extension ID key in development", () => {
    expect(createDesktopManifest(true, "development-public-key")).toEqual(
      expect.objectContaining({ key: "development-public-key" }),
    );
  });

  it("keeps the fixed extension ID key in GitHub release builds", () => {
    expect(createDesktopManifest(true, "development-public-key")).toEqual(
      expect.objectContaining({ key: "development-public-key" }),
    );
  });

  it("omits the development key from Partner Center store builds", () => {
    expect(
      createDesktopManifest(false, "development-public-key"),
    ).not.toHaveProperty("key");
  });
});
