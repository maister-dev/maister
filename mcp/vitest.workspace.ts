import type { TestProjectInlineConfiguration } from "vitest/config";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { testMaxWorkers } from "../scripts/validation-resources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const maxWorkers = testMaxWorkers(process.env);

const alias = {
  "@": resolve(__dirname, "src"),
};

export default [
  {
    resolve: { alias },
    test: {
      name: "unit",
      maxWorkers,
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.integration.test.ts"],
      environment: "node",
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      maxWorkers,
      include: ["src/**/*.integration.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
] satisfies TestProjectInlineConfiguration[];
