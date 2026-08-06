import { describe, expect, it } from "vitest";

import { readUnverifiedIdTokenClaims } from "../../src/features/auth/token";

function encode(value: object): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("readUnverifiedIdTokenClaims", () => {
  it("reads display-only account claims", () => {
    const token = `header.${encode({ name: "One Drop", preferred_username: "one@example.com" })}.signature`;

    expect(readUnverifiedIdTokenClaims(token)).toEqual({
      name: "One Drop",
      preferred_username: "one@example.com",
    });
  });

  it("returns no claims for malformed input", () => {
    expect(readUnverifiedIdTokenClaims("not-a-jwt")).toEqual({});
  });
});
