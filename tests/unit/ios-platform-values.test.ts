import { describe, expect, it } from "vitest";

import { createTextMessage } from "../../src/features/messages/create-text-message";
import {
  iosDownloadId,
  iosImageMetadata,
  iosTimelineResult,
} from "../../ios-web/platform-values";

describe("iOS platform values", () => {
  it("keeps native download identifiers stable and positive", () => {
    expect(iosDownloadId("drive-item-a")).toBe(iosDownloadId("drive-item-a"));
    expect(iosDownloadId("drive-item-a")).toBeGreaterThan(0);
    expect(iosDownloadId("drive-item-a")).not.toBe(
      iosDownloadId("drive-item-b"),
    );
  });

  it("converts a native timeline into the shared month response", () => {
    const message = createTextMessage(
      "from iOS",
      new Date("2026-08-14T12:00:00.000Z"),
      "0198a123-4567-7000-8000-000000000001",
      "0198a123-4567-7000-8000-000000000002",
    );
    expect(
      iosTimelineResult({
        month: "2026-08",
        appFolderName: "OneDrop",
        messages: [message],
        warnings: [],
        synchronizedAt: "2026-08-14T12:00:01.000Z",
      }),
    ).toEqual({
      state: "loaded",
      month: "2026-08",
      eTag: "ios-native",
      messages: [message],
    });
  });

  it("preserves image metadata across the iOS transfer bridge", () => {
    expect(
      iosImageMetadata({
        imageWidth: 4032,
        imageHeight: 3024,
        thumbHash: "AQIDBA==",
      }),
    ).toEqual({
      imageWidth: 4032,
      imageHeight: 3024,
      thumbHash: "AQIDBA==",
    });
  });
});
