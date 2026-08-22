import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const wxtCli = resolve("node_modules", "wxt", "bin", "wxt.mjs");
const result = spawnSync(
  process.execPath,
  [wxtCli, "zip", "--browser", "edge"],
  {
    env: { ...process.env, ONEDROP_STORE_PACKAGE: "1" },
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  throw new Error("Microsoft Edge Partner Center ZIP generation failed.");
}
