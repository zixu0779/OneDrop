import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sycamore.onedrop",
  appName: "OneDrop",
  webDir:
    process.env.ONEDROP_NATIVE_PLATFORM === "android"
      ? "dist/android"
      : "dist/ios",
  android: { path: "apps/android/native" },
  // MainActivity applies Android system-bar and keyboard insets to the native layout.
  plugins: { SystemBars: { insetsHandling: "disable" } },
  ios: {
    path: "apps/ios/native",
    contentInset: "never",
  },
};

export default config;
