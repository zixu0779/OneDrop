import { mountNativeApp } from "@onedrop/native-runtime/NativeApp";
import "@onedrop/ui/styles.css";
import "@onedrop/ui/mobile.css";
import { setPlatformBridge } from "@onedrop/platform/platform/platform-bridge";
import { nativePlatformBridge } from "@onedrop/native-runtime/native-platform-bridge";

document.body.classList.add(
  "mobile-surface",
  "android-surface",
  "native-surface",
);
setPlatformBridge(nativePlatformBridge);
const root = document.getElementById("root");
if (!root) throw new Error("OneDrop Android root was not found.");

void mountNativeApp(root);
