import { describe, expect, it } from "vitest";

import { parseAppFolder } from "../../src/infrastructure/onedrive/app-folder";

describe("parseAppFolder", () => {
  it("accepts a valid App Folder response without a specialFolder facet", () => {
    expect(
      parseAppFolder({
        id: "drive-item-id",
        name: "OneDrop Development",
        webUrl: "https://example.com/Apps/OneDrop",
      }),
    ).toEqual({
      id: "drive-item-id",
      name: "OneDrop Development",
      webUrl: "https://example.com/Apps/OneDrop",
    });
  });

  it("accepts the documented approot facet", () => {
    expect(
      parseAppFolder({
        id: "drive-item-id",
        name: "OneDrop Development",
        specialFolder: { name: "approot" },
      }),
    ).toEqual({
      id: "drive-item-id",
      name: "OneDrop Development",
    });
  });
});
