const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

// `lumine` is provided by the Lumine runtime, not resolvable from this manifest.
const runtimeModules = ["lumine"];

module.exports = [
  {
    // Vendored PDF.js and its custom patch layer ship as-is; the local dev
    // sandbox is not linted.
    ignores: ["node_modules/**", "vendors/**", ".dev/**"],
  },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    settings: {
      // Lumine bundles its own Node 24 runtime; lint against that, not engines.
      n: { version: ">=24.0.0" },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "readonly",
      },
    },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
    },
  },
  {
    // Dev tooling (this config, the manual update script) legitimately requires
    // devDependencies and may call process.exit; it is never shipped as runtime.
    files: ["eslint.config.js", "scripts/**"],
    rules: {
      "n/no-process-exit": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Specs run in the Lumine jasmine runner and require devDependencies.
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: { globals: { ...globals.jasmine } },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off lint rules that would conflict with Prettier.
  prettier,
];
