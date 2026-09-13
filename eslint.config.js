import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-website/**",
      "**/coverage/**",
      "playwright-report/**",
      "test-results/**",
      "tmp/**",
      ".cache/**",
      "apps/android/**/build/**",
      "apps/android/.gradle/**",
      "apps/android/app/src/main/assets/web/**",
      "**/artifacts/**",
      // Local experiment records remain on disk after leaving source control.
      "docs/plans/**",
      "docs/reports/**",
      "docs/evals/reply-steering/evidence/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
  {
    files: ["eslint.config.js", "scripts/prepare-dearvale-fonts.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["apps/desktop-online/src/connection.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
