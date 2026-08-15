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
      "ios/App/App/public/**",
      "ios/App/Pods/**",
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
);
