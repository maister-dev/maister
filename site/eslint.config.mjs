import { defineConfig, globalIgnores } from "eslint/config";
import next from "@next/eslint-plugin-next";
import typescript from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import react from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";
import reactJsx from "eslint-plugin-react-jsx";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y-x";

export default defineConfig([
  globalIgnores([".next/**", "out/**", "next-env.d.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser },
    plugins: {
      "@next/next": next,
      "@typescript-eslint": typescript,
      "react-x": react,
      "react-dom": reactDom,
      "react-jsx": reactJsx,
      "react-hooks": reactHooks,
      "jsx-a11y-x": jsxA11y,
    },
    rules: {
      ...next.configs["core-web-vitals"].rules,
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      "react-x/no-missing-key": "error",
      "react-x/no-duplicate-key": "error",
      "react-jsx/no-children-prop": "error",
      "react-jsx/no-comment-textnodes": "error",
      "react-dom/no-dangerously-set-innerhtml-with-children": "error",
      "react-dom/no-void-elements-with-children": "error",
    },
  },
]);
