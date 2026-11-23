import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.addons.microsoftedge.microsoft.com/v1";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60;

function requireEnvironment(name, preserveWhitespace = false) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return preserveWhitespace ? value : value.trim();
}

function certificationCredential(fixedNotes, label) {
  const pattern = new RegExp(`^[ \t]*${label}:[ \t]?([^\r\n]*)$`, "i");
  const matches = fixedNotes
    .split(/\r\n|\r|\n/u)
    .map((line) => pattern.exec(line))
    .filter(Boolean);
  if (matches.length !== 1 || !matches[0][1].trim()) {
    throw new Error(
      `EDGE_ADDONS_CERTIFICATION_NOTES must contain exactly one non-empty ${label}: line.`,
    );
  }
  return matches[0][1];
}

export function composeCertificationNotes(fixedNotes, versionNotes) {
  if (!versionNotes?.trim()) {
    throw new Error("Version-specific certification notes must not be empty.");
  }
  const username = certificationCredential(fixedNotes, "Username");
  const password = certificationCredential(fixedNotes, "Password");
  return `ONEDROP CERTIFICATION INSTRUCTIONS

OneDrop signs in through Microsoft Entra ID OAuth and does not require a separate OneDrop account or password. Messages and files are stored in the signed-in account's OneDrive.

OPTION 1 — USE YOUR OWN MICROSOFT TEST ACCOUNT (RECOMMENDED)

Use your own Microsoft test account with OneDrive already set up. Complete any Microsoft email-code, passkey, or other verification using that account's verification methods. OneDrop requires no developer approval or account provisioning.

OPTION 2 — USE THE PROVIDED TEST ACCOUNT

Username: ${username}
Password: ${password}

The provided test account uses password sign-in. If Microsoft defaults to email-code or passkey sign-in, select "Other ways to sign in" or "Sign in another way", then "Use your password" and enter the provided password.

Although two-step verification is disabled for the provided test account, Microsoft may still require additional verification on a new device or network, or when it detects a sign-in risk. If you cannot complete that verification independently, use your own Microsoft test account as described in Option 1.

TEST STEPS

1. Install OneDrop in Microsoft Edge and open the extension.
2. Select "Sign in with Microsoft".
3. Use either account option above and complete Microsoft's verification and consent prompts.
4. Wait for the message timeline to load. An empty timeline is normal for an account with no messages.
5. Send a text message and upload a file. Confirm both complete successfully, then check file preview, download, and opening.
6. Open OneDrop on a second device or in an independent Edge profile, and sign in with the same Microsoft account.
7. Refresh or wait for synchronization. Confirm that the text and file arrive, then send a message or file back and verify receipt on the first client.
8. Check message deletion, recycle-bin restoration, and settings. Before testing restoration, make sure the recycle bin is not disabled in Settings.

On first use, OneDrop may need to initialize its app folder in OneDrive. Wait briefly, then reopen the extension if necessary.

VERSION-SPECIFIC NOTES

${versionNotes.trim()}`;
}

export function redactCertificationNotes(certificationNotes) {
  return certificationNotes.replace(
    /^Password:[^\r\n]*$/gim,
    "Password: [REDACTED]",
  );
}

async function writeCertificationNotesSummary(certificationNotes) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const preview = redactCertificationNotes(certificationNotes)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  await appendFile(
    summaryPath,
    `## Certification notes preview\n\nThe following matches the submitted certification notes, except that the test-account password is redacted.\n\n${preview}\n`,
    "utf8",
  );
}

function operationIdFrom(response) {
  const location = response.headers.get("location")?.trim();
  if (!location) {
    throw new Error(
      "Microsoft Edge Add-ons API response has no Location header.",
    );
  }
  return location.replace(/\/$/, "").split("/").pop();
}

export function isExpectedHttpStatus(status, expectedStatuses) {
  return expectedStatuses.includes(status);
}

async function ensureResponse(response, expectedStatuses, operation) {
  if (isExpectedHttpStatus(response.status, expectedStatuses)) return;
  const body = await response.text();
  throw new Error(
    `${operation} failed with HTTP ${response.status}: ${body || response.statusText}`,
  );
}

async function pollOperation(url, headers, label) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { headers });
    await ensureResponse(response, [200, 202], `${label} status check`);
    const result = await response.json();

    if (result.status === "Succeeded") return result;
    if (result.status === "Failed") {
      throw new Error(
        `${label} failed: ${JSON.stringify({
          message: result.message,
          errorCode: result.errorCode,
          errors: result.errors,
        })}`,
      );
    }
    if (result.status !== "InProgress") {
      throw new Error(`${label} returned unexpected status: ${result.status}`);
    }

    console.log(
      `${label} is still in progress (${attempt}/${MAX_POLL_ATTEMPTS}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${label} did not finish before the polling timeout.`);
}

async function main() {
  const productId = requireEnvironment("EDGE_ADDONS_PRODUCT_ID");
  const apiKey = requireEnvironment("EDGE_ADDONS_API_KEY");
  const clientId = requireEnvironment("EDGE_ADDONS_CLIENT_ID");
  const fixedNotes = requireEnvironment(
    "EDGE_ADDONS_CERTIFICATION_NOTES",
    true,
  );
  const packagePath = requireEnvironment("EDGE_ADDONS_PACKAGE_PATH");
  const versionNotesPath = requireEnvironment("EDGE_ADDONS_VERSION_NOTES_PATH");

  const [packageBytes, versionNotes] = await Promise.all([
    readFile(packagePath),
    readFile(versionNotesPath, "utf8"),
  ]);
  const certificationNotes = composeCertificationNotes(
    fixedNotes,
    versionNotes,
  );
  await writeCertificationNotesSummary(certificationNotes);

  if (process.env.EDGE_ADDONS_DRY_RUN === "1") {
    console.log(
      "Partner Center dry run passed: package and certification notes are ready.",
    );
    return;
  }

  const productPath = `${API_ROOT}/products/${encodeURIComponent(productId)}`;
  const authorizationHeaders = {
    Authorization: `ApiKey ${apiKey}`,
    "X-ClientID": clientId,
  };

  console.log("Uploading the universal Edge package to Partner Center.");
  const uploadResponse = await fetch(
    `${productPath}/submissions/draft/package`,
    {
      method: "POST",
      headers: {
        ...authorizationHeaders,
        "Content-Type": "application/zip",
      },
      body: packageBytes,
    },
  );
  await ensureResponse(uploadResponse, [202], "Package upload");
  const uploadOperationId = operationIdFrom(uploadResponse);
  await pollOperation(
    `${productPath}/submissions/draft/package/operations/${encodeURIComponent(uploadOperationId)}`,
    authorizationHeaders,
    "Package validation",
  );

  console.log("Package validation succeeded; submitting it for certification.");
  const publishResponse = await fetch(`${productPath}/submissions`, {
    method: "POST",
    headers: {
      ...authorizationHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ notes: certificationNotes }),
  });
  await ensureResponse(publishResponse, [202], "Certification submission");
  const publishOperationId = operationIdFrom(publishResponse);
  await pollOperation(
    `${productPath}/submissions/operations/${encodeURIComponent(publishOperationId)}`,
    authorizationHeaders,
    "Certification submission",
  );
  console.log("Partner Center accepted the submission for certification.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
