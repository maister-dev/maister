import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineWorkspace } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const alias = {
  "@": resolve(__dirname, "src"),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "unit",
      include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
      exclude: ["src/**/*.integration.test.ts"],
      environment: "node",
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      include: ["src/**/*.integration.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
