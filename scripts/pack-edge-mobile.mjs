import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const wxtCli = resolve(projectRoot, "node_modules", "wxt", "bin", "wxt.mjs");
const extensionDirectory = resolve(projectRoot, ".output/edge-mv3");
const generatedCrx = `${extensionDirectory}.crx`;
const generatedPem = `${extensionDirectory}.pem`;
const packagedCrx = resolve(projectRoot, ".output/edge-mobile/edge-mv3.crx");
const keyDirectory = resolve(projectRoot, ".keys");
const persistentKey = resolve(keyDirectory, "mobile-dev.pem");
const legacyAndroidKey = resolve(keyDirectory, "android-dev.pem");
const edgeBinary =
  process.env.ONEDROP_CHROMIUM_BINARY?.trim() ||
  (process.platform === "darwin"
    ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    : "msedge");

const extensionBuild = spawnSync(
  process.execPath,
  [wxtCli, "build", "--browser", "edge"],
  {
    cwd: projectRoot,
    env: { ...process.env, ONEDROP_STORE_PACKAGE: "1" },
    stdio: "inherit",
  },
);
if (extensionBuild.status !== 0) {
  throw new Error("The universal Edge Mobile build failed.");
}

const manifestPath = resolve(extensionDirectory, "manifest.json");
const requiredPages = ["android-mobile.html", "ios-mobile.html"];
if (
  !existsSync(manifestPath) ||
  requiredPages.some((page) => !existsSync(resolve(extensionDirectory, page)))
) {
  throw new Error("The Edge Mobile extension build is incomplete.");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.action?.default_popup) {
  throw new Error(
    "The universal Edge package must select its popup at runtime.",
  );
}
const testVersion = process.env.ONEDROP_EDGE_TEST_VERSION?.trim();
if (testVersion) {
  if (!/^\d+(?:\.\d+){0,3}$/u.test(testVersion)) {
    throw new Error(
      "ONEDROP_EDGE_TEST_VERSION must contain one to four numeric components.",
    );
  }
  manifest.version = testVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Edge Mobile test package version: ${testVersion}`);
}

mkdirSync(keyDirectory, { recursive: true });
if (!existsSync(persistentKey) && existsSync(legacyAndroidKey)) {
  copyFileSync(legacyAndroidKey, persistentKey);
}
if (!existsSync(persistentKey) && existsSync(generatedPem)) {
  renameSync(generatedPem, persistentKey);
}
const argumentsList = [`--pack-extension=${extensionDirectory}`];
if (existsSync(persistentKey)) {
  argumentsList.push(`--pack-extension-key=${persistentKey}`);
}

const result = spawnSync(edgeBinary, argumentsList, { stdio: "inherit" });
if (result.status !== 0 || !existsSync(generatedCrx)) {
  throw new Error("Microsoft Edge did not create the Edge Mobile CRX.");
}
if (!existsSync(persistentKey) && existsSync(generatedPem)) {
  renameSync(generatedPem, persistentKey);
}
if (!existsSync(persistentKey)) {
  throw new Error("Microsoft Edge did not create the mobile signing key.");
}
mkdirSync(resolve(projectRoot, ".output/edge-mobile"), { recursive: true });
renameSync(generatedCrx, packagedCrx);
console.log(`Edge Mobile CRX: ${packagedCrx}`);
console.log(`Persistent signing key: ${persistentKey}`);
