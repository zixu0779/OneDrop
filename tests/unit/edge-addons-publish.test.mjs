import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  composeCertificationNotes,
  isExpectedHttpStatus,
  redactCertificationNotes,
} from "../../scripts/publish-edge-addons.mjs";

describe("Edge Add-ons certification notes", () => {
  it("replaces legacy guidance with the approved instructions and exact credentials", () => {
    const username = "reviewer+test@example.com";
    const password = String.raw`$p\a:ss"'&<> `;
    const notes = composeCertificationNotes(
      `Legacy misleading instructions: never use password login.\r\nUsername: ${username}\r\nPassword: ${password}\r\nOld version 1.0.3 only.`,
      "- Updated the universal Edge package.",
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
      expect(() => composeCertificationNotes(fixedNotes, "- Update.")).toThrow(
        `EDGE_ADDONS_CERTIFICATION_NOTES must contain exactly one non-empty ${label}: line.`,
      );
    },
  );

  it("preserves secret whitespace through the dry-run CLI and masks the preview", () => {
    const directory = mkdtempSync(join(tmpdir(), "onedrop-notes-"));
    try {
      const password = String.raw`  $p\a:ss"'&<>  `;
      const packagePath = join(directory, "package.zip");
      const notesPath = join(directory, "version-notes.md");
      const networkGuardPath = join(directory, "no-network.mjs");
      writeFileSync(
        networkGuardPath,
        'globalThis.fetch = () => { throw new Error("Network access forbidden in dry run"); };',
      );
      const summaryPath = join(directory, "summary.md");
      writeFileSync(packagePath, "synthetic dry-run package");
      writeFileSync(notesPath, "- Current release change.");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          networkGuardPath,
          resolve("scripts/publish-edge-addons.mjs"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            EDGE_ADDONS_PRODUCT_ID: "test-product",
            EDGE_ADDONS_API_KEY: "test-key",
            EDGE_ADDONS_CLIENT_ID: "test-client",
            EDGE_ADDONS_CERTIFICATION_NOTES: `Old guidance.\nUsername: reviewer@example.com\nPassword: ${password}`,
            EDGE_ADDONS_PACKAGE_PATH: packagePath,
            EDGE_ADDONS_VERSION_NOTES_PATH: notesPath,
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

  it.each(["missing-path", "missing-file", "blank-file"])(
    "fails before network access for %s",
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "onedrop-notes-invalid-"));
      try {
        const packagePath = join(directory, "package.zip");
        const notesPath = join(directory, "notes.md");
        const guardPath = join(directory, "guard.mjs");
        writeFileSync(packagePath, "synthetic package");
        writeFileSync(
          guardPath,
          'globalThis.fetch = () => { throw new Error("UNEXPECTED_NETWORK"); };',
        );
        if (kind === "blank-file") writeFileSync(notesPath, " \n\t");
        const result = spawnSync(
          process.execPath,
          ["--import", guardPath, resolve("scripts/publish-edge-addons.mjs")],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              EDGE_ADDONS_PRODUCT_ID: "test-product",
              EDGE_ADDONS_API_KEY: "test-key",
              EDGE_ADDONS_CLIENT_ID: "test-client",
              EDGE_ADDONS_CERTIFICATION_NOTES:
                "Username: reviewer\nPassword: synthetic-secret",
              EDGE_ADDONS_PACKAGE_PATH: packagePath,
              EDGE_ADDONS_VERSION_NOTES_PATH:
                kind === "missing-path" ? "" : notesPath,
              EDGE_ADDONS_DRY_RUN: "0",
              GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          kind === "missing-path"
            ? "Missing required environment variable: EDGE_ADDONS_VERSION_NOTES_PATH"
            : kind === "missing-file"
              ? "ENOENT"
              : "Version-specific certification notes must not be empty.",
        );
        expect(result.stderr).not.toContain("UNEXPECTED_NETWORK");
        expect(result.stderr).not.toContain("synthetic-secret");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("loads tag-specific notes from current automation without reading a public release body", () => {
    const workflow = readFileSync(
      resolve(".github/workflows/release-assets.yml"),
      "utf8",
    );
    expect(
      workflow.match(/export EDGE_ADDONS_VERSION_NOTES_PATH=/gu),
    ).toHaveLength(1);
    expect(
      workflow.slice(0, workflow.indexOf("  partner-center:")),
    ).not.toContain("EDGE_ADDONS_VERSION_NOTES_PATH");
    const partner = workflow.slice(workflow.indexOf("  partner-center:"));
    expect(partner).toContain(
      "automation-source/.github/partner-center-notes/${RELEASE_TAG}.md",
    );
    expect(partner).toContain(
      '[[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
    expect(partner).not.toContain("gh release view");
    expect(partner).not.toContain("EDGE_ADDONS_RELEASE_BODY_PATH");
    expect(partner).toContain(
      "inputs.partner_center_mode == 'publish' && '0' || '1'",
    );
  });

  it.each([undefined, "", " \r\n\t"])(
    "rejects missing or blank version notes",
    (notes) => {
      expect(() =>
        composeCertificationNotes(
          "Username: reviewer\nPassword: secret",
          notes,
        ),
      ).toThrow("Version-specific certification notes must not be empty.");
    },
  );

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
