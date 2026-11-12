import { defineConfig, globalIgnores } from "eslint/config";
import unusedImports from "eslint-plugin-unused-imports";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import stylistic from "@stylistic/eslint-plugin";
import perfectionist from "eslint-plugin-perfectionist";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import next from "@next/eslint-plugin-next";
import react from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";
import reactJsx from "eslint-plugin-react-jsx";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import { importX } from "eslint-plugin-import-x";

const cronerRestriction = {
  name: "croner",
  message:
    "Import cron helpers from @/lib/run-schedules/cron — croner is wrapped (ADR-071).",
};

export default defineConfig([
  globalIgnores([
    ".now/*",
    "**/*.css",
    "**/.changeset",
    "**/dist",
    "esm/*",
    "public/*",
    "tests/*",
    "scripts/*",
    "**/*.config.js",
    "**/.DS_Store",
    "**/node_modules",
    "**/coverage",
    "**/.next",
    "**/build",
    "!**/.commitlintrc.cjs",
    "!**/.lintstagedrc.cjs",
    "!**/jest.config.js",
    "!**/plopfile.js",
    "!**/react-shim.js",
    "!**/tsup.config.ts",
  ]),
  {
    extends: [prettierRecommended],

    plugins: {
      "@next/next": next,
      "react-x": react,
      "react-dom": reactDom,
      "react-jsx": reactJsx,
      "react-hooks": reactHooks,
      "jsx-a11y-x": jsxA11y,
      "import-x": importX,
      "unused-imports": unusedImports,
      "@typescript-eslint": typescriptEslint,
      "@stylistic": stylistic,
      perfectionist,
    },

    languageOptions: {
      globals: {
        ...Object.fromEntries(
          Object.entries(globals.browser).map(([key]) => [key, "off"]),
        ),
        ...globals.node,
      },

      parser: tsParser,
      ecmaVersion: 12,
      sourceType: "module",

      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },

    settings: {
      react: {
        version: "detect",
      },
    },

    files: ["**/*.ts", "**/*.tsx"],

    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      ...next.configs.recommended.rules,
      "react-x/no-direct-mutation-state": "error",
      "react-x/no-missing-key": "error",
      "react-x/no-missing-component-display-name": "error",
      "react-x/no-duplicate-key": "error",
      "react-x/no-unsafe-component-will-mount": "error",
      "react-x/no-unsafe-component-will-receive-props": "error",
      "react-x/no-unsafe-component-will-update": "error",
      "react-jsx/no-children-prop": "error",
      "react-jsx/no-comment-textnodes": "error",
      "react-dom/no-dangerously-set-innerhtml-with-children": "error",
      "react-dom/no-find-dom-node": "error",
      "react-dom/no-render-return-value": "error",
      "react-dom/no-unknown-property": "error",
      "react-dom/no-unsafe-target-blank": "error",
      "react-dom/no-void-elements-with-children": "error",
      "no-console": "warn",
      "react-hooks/exhaustive-deps": "off",
      "jsx-a11y-x/click-events-have-key-events": "warn",
      "jsx-a11y-x/interactive-supports-focus": "warn",
      "prettier/prettier": "warn",
      "no-unused-vars": "off",
      "unused-imports/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          ignoreRestSiblings: false,
          argsIgnorePattern: "^_.*?$",
          // `ignoreRestSiblings` stays false so a genuinely dead sibling is
          // still reported; the `_` prefix is the per-variable opt-in for the
          // omit-via-rest idiom (`const { a: _a, ...without } = x`), matching
          // how the same prefix already exempts arguments above.
          varsIgnorePattern: "^_.*?$",
        },
      ],

      "import-x/order": [
        "warn",
        {
          groups: [
            "type",
            "builtin",
            "object",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],

          pathGroups: [
            {
              pattern: "~/**",
              group: "external",
              position: "after",
            },
          ],

          "newlines-between": "always",
        },
      ],

      "@stylistic/jsx-self-closing-comp": "warn",

      "perfectionist/sort-jsx-props": [
        "warn",
        {
          type: "alphabetical",
          order: "asc",
          ignoreCase: false,
          groups: ["reserved", "shorthand-prop", "unknown", "callback"],
          customGroups: [
            { groupName: "reserved", elementNamePattern: "^(children|key|ref|dangerouslySetInnerHTML)$" },
            { groupName: "callback", elementNamePattern: "^on[A-Z]" },
          ],
        },
      ],

      "@stylistic/padding-line-between-statements": [
        "warn",
        {
          blankLine: "always",
          prev: "*",
          next: "return",
        },
        {
          blankLine: "always",
          prev: ["const", "let", "var"],
          next: "*",
        },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
      ],

      "no-restricted-imports": [
        "error",
        {
          paths: [
            cronerRestriction,
            {
              name: "@/lib/supervisor-client",
              message:
                "ADR-166: domain code addresses execution through @/lib/execution-host (BoundClient / HostAdminClient); the supervisor wire is fenced to lib/execution-host/**.",
            },
            {
              name: "@/lib/execution-host/import-maintenance",
              message:
                "S4.3: the historical-import maintenance protocol is an operator-only surface on a Unix socket. Only the import CLI under scripts/ may speak it; it is deliberately absent from createExecutionHosts().",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/librarian/**"],

    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            cronerRestriction,
            {
              name: "@/lib/supervisor-client",
              message: "Use the execution-host client for supervisor access.",
            },
            {
              name: "@/lib/execution-host/import-maintenance",
              message: "Historical import maintenance is operator-only.",
            },
          ],
          patterns: [
            {
              group: ["@/lib/brain/**", "@/lib/agents/memory-store", "**/brain/**", "**/agents/memory-store"],
              message: "Personal librarian memory must stay separate from Project Brain and agent memory.",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-166 D10: the local-direct transport, the test doubles and the test
    // suites (module mocks by path) are the only places the wire may be named.
    files: [
      "lib/execution-host/**",
      "lib/supervisor-client.ts",
      "test-support/**",
      "e2e/**",
      "**/__tests__/**",
    ],

    rules: {
      "no-restricted-imports": ["error", { paths: [cronerRestriction] }],
    },
  },
  {
    files: ["lib/run-schedules/cron.ts"],

    rules: {
      "no-restricted-imports": "off",
    },
  },
]);
