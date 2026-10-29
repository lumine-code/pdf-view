const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

// `lumine` is provided by the Lumine runtime, not resolvable from this manifest.
const runtimeModules = ["lumine"];

module.exports = [
  {
    ignores: ["node_modules/**", ".dev/**", "demo/**"],
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
    // Development scripts may use devDependencies and process.exit.
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
    languageOptions: {
      globals: { ...globals.jasmine, conditionPromise: "readonly", flushMicrotasks: "readonly" },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off lint rules that would conflict with Prettier.
  prettier,
];
