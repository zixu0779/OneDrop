import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const betaVersion = args[1];
if (
  args.length &&
  (args.length !== 2 ||
    args[0] !== "--beta" ||
    !/^[1-9]\d{0,3}\.(?:0|[1-9]\d?)\.(?:0|[1-9]\d?)$/u.test(betaVersion))
) {
  throw new Error("Usage: npm run pack:ios -- --beta 1.0.0");
}
const projectRoot = resolve(import.meta.dirname, "..");
const workspace = resolve(projectRoot, "apps/ios/native/App/App.xcworkspace");
const outputDirectory = resolve(
  projectRoot,
  betaVersion ? ".output/ios-beta" : ".output/ios-native",
);
const derivedData = resolve(outputDirectory, "DerivedData");
const packageDirectory = resolve(outputDirectory, "package");
const payloadDirectory = resolve(packageDirectory, "Payload");
const builtApp = resolve(
  derivedData,
  "Build/Products/Release-iphoneos/App.app",
);
const packagedApp = resolve(payloadDirectory, "OneDrop.app");
const ipaPath = resolve(
  outputDirectory,
  betaVersion
    ? `OneDrop-Beta-${betaVersion}.ipa`
    : "onedrop-ios-livecontainer.ipa",
);

if (process.platform !== "darwin") {
  throw new Error("The native iOS IPA must be built on macOS with Xcode.");
}
if (!existsSync(workspace)) {
  throw new Error("The Capacitor iOS workspace is missing.");
}

execFileSync("npm", ["run", "sync:ios"], {
  cwd: projectRoot,
  env: { ...process.env, VITE_ONEDROP_IOS_BETA_VERSION: betaVersion ?? "" },
  stdio: "inherit",
});

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

if (betaVersion) {
  const appId = "com.sycamore.onedrop.beta";
  for (const [key, value] of Object.entries({
    CFBundleIdentifier: appId,
    CFBundleDisplayName: "OneDrop Beta",
    CFBundleName: "OneDrop Beta",
    CFBundleShortVersionString: betaVersion,
    CFBundleVersion: betaVersion,
  })) {
    execFileSync("plutil", ["-replace", key, "-string", value, infoPlist]);
  }
  execFileSync("plutil", [
    "-insert",
    "OneDropAuthKeychainService",
    "-string",
    `${appId}.microsoft-auth`,
    infoPlist,
  ]);
  const capacitorConfig = resolve(packagedApp, "capacitor.config.json");
  const config = JSON.parse(readFileSync(capacitorConfig, "utf8"));
  writeFileSync(
    capacitorConfig,
    JSON.stringify({ ...config, appId, appName: "OneDrop Beta" }, null, 2),
  );
}

const archive = spawnSync("zip", ["-qry", ipaPath, "Payload"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

if (archive.status !== 0 || !existsSync(ipaPath)) {
  throw new Error("The unsigned OneDrop IPA could not be created.");
}

console.log(`LiveContainer IPA: ${ipaPath}`);
