import type { TestProjectInlineConfiguration } from "vitest/config";

import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import { testMaxWorkers } from "../scripts/validation-resources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const maxWorkers = testMaxWorkers(process.env);
const testWorktreeInvocationId =
  process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID ?? randomUUID();
const testEnvironment = {
  MAISTER_TEST_WORKTREE_INVOCATION_ID: testWorktreeInvocationId,
  MAISTER_SCHEDULER_TIMER_ENABLED: "false",
};

const alias = {
  "@": resolve(__dirname, "."),
  "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
};

export default [
  {
    resolve: { alias },
    test: {
      name: "unit",
      maxWorkers,
      include: [
        "lib/**/*.test.ts",
        "app/**/__tests__/**/*.test.ts",
        "components/**/*.test.ts",
        "styles/**/*.test.ts",
        "test-support/**/*.test.ts",
        "scripts/**/*.test.ts",
        "e2e/**/*.test.ts",
      ],
      exclude: [
        "lib/**/*.integration.test.ts",
        "app/**/*.integration.test.ts",
        "scripts/**/*.integration.test.ts",
        "test-support/**/*.integration.test.ts",
        "e2e/**/*.integration.test.ts",
      ],
      environment: "node",
      env: testEnvironment,
      setupFiles: ["./test-support/vitest-worktree-root.setup.ts"],
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      maxWorkers,
      exclude:
        process.platform === "linux"
          ? []
          : [
              "test-support/__tests__/linux-isolation-driver.integration.test.ts",
            ],
      include: [
        "lib/**/*.integration.test.ts",
        "app/**/*.integration.test.ts",
        "scripts/**/*.integration.test.ts",
        "test-support/**/*.integration.test.ts",
        "e2e/**/*.integration.test.ts",
      ],
      environment: "node",
      env: testEnvironment,
      setupFiles: ["./test-support/vitest-worktree-root.setup.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
] satisfies TestProjectInlineConfiguration[];
