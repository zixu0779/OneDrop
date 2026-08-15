import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sycamore.onedrop",
  appName: "OneDrop",
  webDir: "dist/ios",
  ios: {
    contentInset: "never",
  },
};

export default config;
