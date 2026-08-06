import { describe, expect, it } from "vitest";

import { getUtcMonth } from "../../src/features/messages/month";

describe("getUtcMonth", () => {
  it("partitions by UTC rather than local calendar time", () => {
    expect(getUtcMonth(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
    expect(getUtcMonth(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08");
  });
});
