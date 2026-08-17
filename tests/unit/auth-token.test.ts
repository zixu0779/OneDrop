import { describe, expect, it } from "vitest";

import { readUnverifiedIdTokenClaims } from "@onedrop/app-runtime/features/auth/token";

function encode(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("readUnverifiedIdTokenClaims", () => {
  it("reads display-only account claims", () => {
    const token = `header.${encode({ name: "一滴水", preferred_username: "one@example.com" })}.signature`;

    expect(readUnverifiedIdTokenClaims(token)).toEqual({
      name: "一滴水",
      preferred_username: "one@example.com",
    });
  });

  it("returns no claims for malformed input", () => {
    expect(readUnverifiedIdTokenClaims("not-a-jwt")).toEqual({});
  });
});
