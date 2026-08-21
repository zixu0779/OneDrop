import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const workspace = resolve(projectRoot, "apps/ios/native/App/App.xcworkspace");
const outputDirectory = resolve(projectRoot, ".output/ios-native");
const derivedData = resolve(outputDirectory, "DerivedData");
const packageDirectory = resolve(outputDirectory, "package");
const payloadDirectory = resolve(packageDirectory, "Payload");
const builtApp = resolve(
  derivedData,
  "Build/Products/Release-iphoneos/App.app",
);
const packagedApp = resolve(payloadDirectory, "OneDrop.app");
const ipaPath = resolve(outputDirectory, "onedrop-ios-livecontainer.ipa");

if (process.platform !== "darwin") {
  throw new Error("The native iOS IPA must be built on macOS with Xcode.");
}
if (!existsSync(workspace)) {
  throw new Error("The Capacitor iOS workspace is missing.");
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const build = spawnSync(
  "xcodebuild",
  [
    "-workspace",
    workspace,
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-sdk",
    "iphoneos",
    "-derivedDataPath",
    derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_IDENTITY=",
    "DEVELOPMENT_TEAM=",
    "build",
  ],
  { stdio: "inherit" },
);

if (build.status !== 0 || !existsSync(builtApp)) {
  throw new Error("Xcode did not produce the unsigned OneDrop app bundle.");
}

mkdirSync(payloadDirectory, { recursive: true });
cpSync(builtApp, packagedApp, { recursive: true });

const infoPlist = resolve(packagedApp, "Info.plist");
if (!existsSync(infoPlist) || readFileSync(infoPlist).length === 0) {
  throw new Error("The packaged OneDrop app is incomplete.");
}

const archive = spawnSync("zip", ["-qry", ipaPath, "Payload"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

if (archive.status !== 0 || !existsSync(ipaPath)) {
  throw new Error("The unsigned OneDrop IPA could not be created.");
}

console.log(`LiveContainer IPA: ${ipaPath}`);
