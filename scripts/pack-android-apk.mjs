import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--release")) {
  throw new Error("Usage: npm run pack:android [-- --release]");
}
const release = args[0] === "--release";
if (release) {
  for (const name of [
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ]) {
    if (!process.env[name]) {
      throw new Error(
        `Missing Android release signing environment variable: ${name}`,
      );
    }
  }
  if (!existsSync(process.env.ANDROID_KEYSTORE_PATH)) {
    throw new Error("The Android release keystore file is missing.");
  }
}
const variant = release ? "release" : "debug";
const windows = process.platform === "win32";
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;
execFileSync(windows ? "npm.cmd" : "npm", ["run", "sync:android"], {
  cwd: root,
  shell: windows,
  stdio: "inherit",
});
const android = resolve(root, "apps/android/native");
execFileSync(
  windows ? "gradlew.bat" : "./gradlew",
  [release ? ":app:assembleRelease" : ":app:assembleDebug", "--no-daemon"],
  { cwd: android, shell: windows, stdio: "inherit" },
);
const output = resolve(root, ".output/android");
mkdirSync(output, { recursive: true });
const apk = resolve(
  output,
  `OneDrop-${version}-android${release ? "" : "-debug"}.apk`,
);
copyFileSync(
  resolve(android, `app/build/outputs/apk/${variant}/app-${variant}.apk`),
  apk,
);
console.log(`Android ${variant} APK: ${apk}`);
