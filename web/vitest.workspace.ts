import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["lib/**/*.test.ts", "lib/**/__tests__/**/*.test.ts"],
      exclude: ["lib/**/*.integration.test.ts"],
      environment: "node",
    },
  },
  {
    test: {
      name: "integration",
      include: ["lib/**/*.integration.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
