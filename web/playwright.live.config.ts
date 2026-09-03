import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { resolvePostgresDbUrl } from "./lib/db/postgres-url";
import { resolveTestWorktreesRoot } from "./test-support/worktree-test-root";

// The opt-in LIVE lane (ADR-165 T6.2): a REAL supervisor with the operator's
// configured adapter behind a dev web server. Specs gate themselves on
// E2E_LIVE_SUPERVISOR=1; nothing here is stubbed.
const WEB_PORT = Number(process.env.E2E_LIVE_WEB_PORT ?? 3101);
const SUPERVISOR_PORT = Number(process.env.MAISTER_SUPERVISOR_PORT ?? 7777);
const BASE_URL =
  process.env.E2E_LIVE_BASE_URL ?? `http://localhost:${WEB_PORT}`;
const SUPERVISOR_URL = `http://127.0.0.1:${SUPERVISOR_PORT}`;
const AUTH_SECRET =
  process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me";
const databaseUrl = resolvePostgresDbUrl();
const worktreesRoot = resolveTestWorktreesRoot("e2e-live", process.env);

process.env.MAISTER_WORKTREES_ROOT = worktreesRoot;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/__tests__/**"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts$/ },
    {
      name: "live-supervisor",
      dependencies: ["setup"],
      testMatch: /live-.*\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
    },
  ],
  webServer: [
    {
      command: `pnpm --dir .. --filter @maister/supervisor dev`,
      url: `${SUPERVISOR_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        MAISTER_SUPERVISOR_PORT: String(SUPERVISOR_PORT),
        MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-live-supervisor"),
        // ADR-165: the lane owns its execution-host state dir and pins the
        // host identity (never a developer's supervisor state), and its
        // adoption roots mirror the lane's worktrees root — a scratch launch
        // adopts the worktree it just created.
        MAISTER_EXECUTION_HOST_STATE_DIR: path.resolve(
          "e2e/.runtime-live-supervisor/.maister/execution-host",
        ),
        MAISTER_EXECUTION_HOST_KEY: "eh_e2e_live_supervisor",
        MAISTER_WORKSPACE_ROOTS: worktreesRoot,
      },
    },
    {
      command: `pnpm exec next dev -p ${WEB_PORT}`,
      url: BASE_URL,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        DB_URL: databaseUrl,
        AUTH_SECRET,
        MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-live-web"),
        MAISTER_WORKTREES_ROOT: worktreesRoot,
        MAISTER_SUPERVISOR_URL: SUPERVISOR_URL,
        // The seeded e2e fixtures hold more than the default cap of live runs;
        // the live scratch launch must be admitted.
        MAISTER_MAX_CONCURRENT_RUNS: "64",
      },
    },
  ],
});
