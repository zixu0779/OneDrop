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

  it("appends version notes after the fixed certification instructions", () => {
    expect(
      composeCertificationNotes(
        "Fixed sign-in instructions.\n",
        "### Partner Center Notes\n\n- Updated the universal Edge package.",
      ),
    ).toBe(
      "Fixed sign-in instructions.\n\nVERSION-SPECIFIC NOTES\n\n- Updated the universal Edge package.",
    );
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
