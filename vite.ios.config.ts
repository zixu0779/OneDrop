import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "ios-web",
  envDir: "..",
  envPrefix: ["VITE_", "WXT_"],
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "../dist/ios",
  },
});
