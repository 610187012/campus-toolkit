import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import js from "@eslint/js";

/**
 * Next 16 已移除 next lint；typescript-eslint 尚不支援本專案的 TypeScript 7，
 * 因此 ESLint 只檢查 JS/MJS；TS/TSX 由 `tsc --noEmit`（npm run typecheck）負責。
 */
const eslintConfig = defineConfig([
  js.configs.recommended,
  globalIgnores([
    ".next/**",
    ".module-sandbox/**",
    "out/**",
    "build/**",
    "node_modules/**",
    "next-env.d.ts",
    "package-lock.json",
    "**/*.ts",
    "**/*.tsx",
  ]),
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["**/*.{js,cjs,jsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
