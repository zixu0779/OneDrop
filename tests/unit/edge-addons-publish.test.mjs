import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  composeCertificationNotes,
  extractVersionNotes,
  isExpectedHttpStatus,
  redactCertificationNotes,
} from "../../scripts/publish-edge-addons.mjs";

describe("Edge Add-ons certification notes", () => {
  it("extracts only the dedicated Partner Center section", () => {
    const releaseBody = `# OneDrop

### Partner Center Notes

- Fixed iOS keyboard positioning.
- Added device removal.

### Installation

Unrelated release content.`;

    expect(extractVersionNotes(releaseBody)).toBe(
      "- Fixed iOS keyboard positioning.\n- Added device removal.",
    );
  });

  it("replaces legacy guidance with the approved instructions and exact credentials", () => {
    const username = "reviewer+test@example.com";
    const password = String.raw`$p\a:ss"'&<> `;
    const notes = composeCertificationNotes(
      `Legacy misleading instructions: never use password login.\r\nUsername: ${username}\r\nPassword: ${password}\r\nOld version 1.0.3 only.`,
      "### Partner Center Notes\n\n- Updated the universal Edge package.\n\n### Other changes\nUnrelated.",
    );

    expect(notes).not.toContain("Legacy misleading instructions");
    expect(notes).not.toContain("Old version 1.0.3");
    expect(notes).toContain(`Username: ${username}\nPassword: ${password}\n`);
    expect(notes).toContain("Microsoft Entra ID OAuth");
    expect(notes).toContain(
      "OPTION 1 — USE YOUR OWN MICROSOFT TEST ACCOUNT (RECOMMENDED)",
    );
    expect(notes).toContain("OneDrive already set up");
    expect(notes).toContain("The provided test account uses password sign-in.");
    expect(notes).toContain('then "Use your password"');
    expect(notes).toContain(
      "Microsoft may still require additional verification",
    );
    expect(notes).toContain(
      "If you cannot complete that verification independently",
    );
    expect(notes).toContain("sign in with the same Microsoft account");
    expect(notes).toContain(
      "8. Check message deletion, recycle-bin restoration, and settings.",
    );
    expect(notes).toContain("initialize its app folder in OneDrive");
    expect(notes).toMatch(
      /\nVERSION-SPECIFIC NOTES\n\n- Updated the universal Edge package\.$/u,
    );
    expect(redactCertificationNotes(notes)).toBe(
      notes.replace(`Password: ${password}`, "Password: [REDACTED]"),
    );
  });

  it.each([
    ["Username", "Password: confidential"],
    ["Username", "Username: \nPassword: confidential"],
    ["Username", "Username: first\nUsername: second\nPassword: confidential"],
    ["Password", "Username: reviewer@example.com"],
    [
      "Password",
      "Username: reviewer@example.com\nPassword:\nDo not consume this line.",
    ],
    ["Password", "Username: reviewer@example.com\nPassword: \t"],
    [
      "Password",
      "Username: reviewer@example.com\nPassword: confidential\nPASSWORD: other",
    ],
  ])(
    "rejects an invalid %s line without revealing secret content",
    (label, fixedNotes) => {
      expect(() =>
        composeCertificationNotes(
          fixedNotes,
          "### Partner Center Notes\n- Update.",
        ),
      ).toThrow(
        `EDGE_ADDONS_CERTIFICATION_NOTES must contain exactly one non-empty ${label}: line.`,
      );
    },
  );

  it("preserves secret whitespace through the dry-run CLI and masks the preview", () => {
    const directory = mkdtempSync(join(tmpdir(), "onedrop-notes-"));
    try {
      const password = String.raw`  $p\a:ss"'&<>  `;
      const packagePath = join(directory, "package.zip");
      const bodyPath = join(directory, "release.md");
      const summaryPath = join(directory, "summary.md");
      writeFileSync(packagePath, "synthetic dry-run package");
      writeFileSync(
        bodyPath,
        "### Partner Center Notes\n\n- Current release change.",
      );
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/publish-edge-addons.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            EDGE_ADDONS_PRODUCT_ID: "test-product",
            EDGE_ADDONS_API_KEY: "test-key",
            EDGE_ADDONS_CLIENT_ID: "test-client",
            EDGE_ADDONS_CERTIFICATION_NOTES: `Old guidance.\nUsername: reviewer@example.com\nPassword: ${password}`,
            EDGE_ADDONS_PACKAGE_PATH: packagePath,
            EDGE_ADDONS_RELEASE_BODY_PATH: bodyPath,
            EDGE_ADDONS_DRY_RUN: "1",
            GITHUB_STEP_SUMMARY: summaryPath,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary).toContain("Password: [REDACTED]");
      expect(summary).not.toContain(password.trim());
      expect(summary).not.toContain("Old guidance.");
      expect(summary).toContain("- Current release change.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a release without concise Partner Center notes", () => {
    expect(() =>
      extractVersionNotes("### Highlights\n\n- General notes"),
    ).toThrow('must contain a "### Partner Center Notes" section');
  });

  it("accepts both completed and in-progress polling responses", () => {
    expect(isExpectedHttpStatus(200, [200, 202])).toBe(true);
    expect(isExpectedHttpStatus(202, [200, 202])).toBe(true);
    expect(isExpectedHttpStatus(500, [200, 202])).toBe(false);
  });

  it("redacts the test-account password from the visible preview", () => {
    const notes =
      "Test account:\nUsername: reviewer@example.com\nPassword: secret-value\n\nVERSION-SPECIFIC NOTES\n\n- Fixed publishing.";

    expect(redactCertificationNotes(notes)).toBe(
      "Test account:\nUsername: reviewer@example.com\nPassword: [REDACTED]\n\nVERSION-SPECIFIC NOTES\n\n- Fixed publishing.",
    );
    expect(notes).toContain("Password: secret-value");
  });
});
