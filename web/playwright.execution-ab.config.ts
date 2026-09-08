import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { resolvePostgresDbUrl } from "./lib/db/postgres-url";
import {
  EXECUTION_AB_SUPERVISOR_URL,
  EXECUTION_AB_WEB_PORT,
} from "./e2e/_seed/execution-ab-lane";
import { resolveTestWorktreesRoot } from "./test-support/worktree-test-root";

// The Stage A/B browser lane: `execution-ab-*.spec.ts` run as the seeded admin
// against a web server whose execution host is a REAL supervisor started by
// `e2e/execution-ab-global-setup.ts` (production boot + mock ACP adapter), not
// the e2e test supervisor of the default lane. Serial, no retries: every case
// is a release-gate observation and a flaky pass is not evidence.
const PORT = Number(process.env.E2E_AB_WEB_PORT ?? EXECUTION_AB_WEB_PORT);
const BASE_URL = `http://localhost:${PORT}`;
const AUTH_SECRET =
  process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me";
const databaseUrl = resolvePostgresDbUrl();
const worktreesRoot = resolveTestWorktreesRoot("e2e", process.env);

process.env.MAISTER_WORKTREES_ROOT = worktreesRoot;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/__tests__/**"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/execution-ab-global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts$/ },
    {
      name: "execution-ab",
      dependencies: ["setup"],
      testMatch: /execution-ab-.*\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DB_URL: databaseUrl,
      AUTH_SECRET,
      // Disjoint from the supervisor's runtime root (a fresh temp dir owned by
      // the real-supervisor harness): the web never reads host runtime data.
      MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-execution-ab-web"),
      MAISTER_WORKTREES_ROOT: worktreesRoot,
      MAISTER_SUPERVISOR_URL: EXECUTION_AB_SUPERVISOR_URL,
      MAISTER_API_BASE_URL: BASE_URL,
      // The seeded fixtures hold more than the default cap of live runs; the
      // lane's launches must be admitted.
      MAISTER_MAX_CONCURRENT_RUNS: "64",
    },
  },
});
