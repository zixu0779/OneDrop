import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".output/**",
      ".wxt/**",
      "coverage/**",
      "dist/**",
      "apps/ios/native/App/App/public/**",
      "apps/ios/native/App/Pods/**",
      "node_modules/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/*", "**/apps/**"],
              message:
                "Apps are composition roots. Move shared code to a package instead of importing another app.",
            },
            {
              group: ["**/entrypoints/*", "**/entrypoints/**"],
              message:
                "Entrypoints are platform-owned and must not be used as shared modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@onedrop/onedrive/**",
            "@onedrop/web-storage/**",
            "@onedrop/platform/**",
            "@onedrop/app-runtime/**",
            "@onedrop/ui/**",
            "wxt/**",
            "@capacitor/**",
          ],
        },
      ],
    },
  },
);
