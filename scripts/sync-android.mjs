import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/@capacitor/cli/bin/capacitor"),
    "sync",
    "android",
  ],
  {
    cwd: root,
    env: { ...process.env, ONEDROP_NATIVE_PLATFORM: "android" },
    stdio: "inherit",
  },
);
