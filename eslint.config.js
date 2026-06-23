import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Flat config: ESLint owns code quality, Prettier owns formatting. The prettier
// config goes last so it switches off every ESLint rule that would fight the
// formatter (we do not run Prettier through ESLint — that path is slower).
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      // Honor the leading-underscore convention for deliberately unused
      // bindings (e.g. a param kept only for signature symmetry).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
