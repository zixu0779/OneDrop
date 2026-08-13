import { existsSync, mkdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const extensionDirectory = resolve(
  projectRoot,
  ".output/edge-android/edge-mv3",
);
const generatedCrx = `${extensionDirectory}.crx`;
const generatedPem = `${extensionDirectory}.pem`;
const keyDirectory = resolve(projectRoot, ".keys");
// Keep the established key filename so existing Android installations retain
// the same extension ID when a new CRX is packed.
const persistentKey = resolve(keyDirectory, "android-probe.pem");
const edgeBinary =
  process.platform === "darwin"
    ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    : "msedge";

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
  throw new Error("Microsoft Edge did not create the Android CRX.");
}
console.log(`Android CRX: ${generatedCrx}`);
console.log(`Persistent signing key: ${persistentKey}`);
