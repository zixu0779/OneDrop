import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const signingNames = [
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

describe("Android release packaging", () => {
  it.each(signingNames)("rejects missing %s before building", (missing) => {
    const env = { ...process.env };
    for (const name of signingNames) env[name] = "synthetic-signing-value";
    delete env[missing];
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/pack-android-apk.mjs"), "--release"],
      { env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Missing Android release signing environment variable: ${missing}`,
    );
    expect(result.stderr).not.toContain("synthetic-signing-value");
    expect(result.stdout).toBe("");
  });

  it("rejects an unavailable keystore before building", () => {
    const env = { ...process.env };
    for (const name of signingNames) env[name] = "synthetic-signing-value";
    env.ANDROID_KEYSTORE_PATH = resolve(".output/missing-release-key.jks");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/pack-android-apk.mjs"), "--release"],
      { env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "The Android release keystore file is missing.",
    );
    expect(result.stderr).not.toContain("synthetic-signing-value");
    expect(result.stdout).toBe("");
  });
});
