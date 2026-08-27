import { describe, expect, it } from "vitest";

import { detectEdgeRuntimePlatform } from "../../packages/extension-runtime/src/edge-platform";

describe("Edge runtime platform detection", () => {
  it("detects Edge on iOS from its user agent", () => {
    expect(
      detectEdgeRuntimePlatform(
        "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 EdgiOS/141.0",
      ),
    ).toBe("ios");
  });

  it("detects Edge on Android from platform information", () => {
    expect(detectEdgeRuntimePlatform("Mozilla/5.0", "android")).toBe("android");
  });

  it("detects Edge on Android from its user agent", () => {
    expect(
      detectEdgeRuntimePlatform(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 EdgA/141.0",
      ),
    ).toBe("android");
  });

  it("defaults desktop Edge to the desktop experience", () => {
    expect(
      detectEdgeRuntimePlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Edg/141.0",
        "mac",
      ),
    ).toBe("desktop");
  });
});
