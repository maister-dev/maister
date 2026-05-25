import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineWorkspace } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const alias = {
  "@": resolve(__dirname, "."),
  "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "unit",
      include: ["lib/**/*.test.ts", "lib/**/__tests__/**/*.test.ts"],
      exclude: ["lib/**/*.integration.test.ts"],
      environment: "node",
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      include: ["lib/**/*.integration.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
