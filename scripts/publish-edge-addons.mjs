import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.addons.microsoftedge.microsoft.com/v1";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60;

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function extractVersionNotes(releaseBody) {
  const lines = releaseBody.replaceAll("\r\n", "\n").split("\n");
  const headingIndex = lines.findIndex((line) =>
    /^###\s+Partner Center Notes\s*$/i.test(line.trim()),
  );

  if (headingIndex === -1) {
    throw new Error(
      'The GitHub Release body must contain a "### Partner Center Notes" section.',
    );
  }

  const sectionLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,3}\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }

  const notes = sectionLines.join("\n").trim();
  if (!notes) {
    throw new Error('The "### Partner Center Notes" section cannot be empty.');
  }
  return notes;
}

export function composeCertificationNotes(fixedNotes, releaseBody) {
  return `${fixedNotes.trim()}\n\nVERSION-SPECIFIC NOTES\n\n${extractVersionNotes(releaseBody)}`;
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

async function ensureResponse(response, expectedStatus, operation) {
  if (response.status === expectedStatus) return;
  const body = await response.text();
  throw new Error(
    `${operation} failed with HTTP ${response.status}: ${body || response.statusText}`,
  );
}

async function pollOperation(url, headers, label) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { headers });
    await ensureResponse(response, 200, `${label} status check`);
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
  const fixedNotes = requireEnvironment("EDGE_ADDONS_CERTIFICATION_NOTES");
  const packagePath = requireEnvironment("EDGE_ADDONS_PACKAGE_PATH");
  const releaseBodyPath = requireEnvironment("EDGE_ADDONS_RELEASE_BODY_PATH");

  const [packageBytes, releaseBody] = await Promise.all([
    readFile(packagePath),
    readFile(releaseBodyPath, "utf8"),
  ]);
  const certificationNotes = composeCertificationNotes(fixedNotes, releaseBody);

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
  await ensureResponse(uploadResponse, 202, "Package upload");
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
  await ensureResponse(publishResponse, 202, "Certification submission");
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
