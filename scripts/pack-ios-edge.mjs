import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const extensionDirectory = resolve(projectRoot, ".output/edge-ios/edge-mv3");
const generatedCrx = `${extensionDirectory}.crx`;
const generatedPem = `${extensionDirectory}.pem`;
const keyDirectory = resolve(projectRoot, ".keys");
const persistentKey = resolve(keyDirectory, "ios-edge-dev.pem");
const edgeBinary =
  process.platform === "darwin"
    ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    : "msedge";

const manifestPath = resolve(extensionDirectory, "manifest.json");
const mobilePagePath = resolve(extensionDirectory, "mobile.html");
if (!existsSync(manifestPath) || !existsSync(mobilePagePath)) {
  throw new Error("The iOS Edge extension build is incomplete.");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.action?.default_popup !== "mobile.html") {
  throw new Error("The iOS Edge extension popup entrypoint is missing.");
}

mkdirSync(keyDirectory, { recursive: true });
if (!existsSync(persistentKey) && existsSync(generatedPem)) {
  renameSync(generatedPem, persistentKey);
}
const argumentsList = [`--pack-extension=${extensionDirectory}`];
if (existsSync(persistentKey)) {
  argumentsList.push(`--pack-extension-key=${persistentKey}`);
}

const result = spawnSync(edgeBinary, argumentsList, { stdio: "inherit" });
if (result.status !== 0 || !existsSync(generatedCrx)) {
  throw new Error("Microsoft Edge did not create the iOS Edge CRX.");
}
if (!existsSync(persistentKey) && existsSync(generatedPem)) {
  renameSync(generatedPem, persistentKey);
}
if (!existsSync(persistentKey)) {
  throw new Error("Microsoft Edge did not create the iOS Edge signing key.");
}
console.log(`iOS Edge CRX: ${generatedCrx}`);
console.log(`Persistent signing key: ${persistentKey}`);
