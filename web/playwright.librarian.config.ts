import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { resolvePostgresDbUrl } from "./lib/db/postgres-url";
import {
  LIBRARIAN_SUPERVISOR_URL,
  LIBRARIAN_WEB_CONTROL_PORT,
  LIBRARIAN_WEB_PORT,
} from "./e2e/_seed/librarian-lane";
import { resolveTestWorktreesRoot } from "./test-support/worktree-test-root";

const port = Number(process.env.E2E_LIBRARIAN_WEB_PORT ?? LIBRARIAN_WEB_PORT);
const baseURL = `http://localhost:${port}`;
const worktreesRoot = resolveTestWorktreesRoot("e2e", process.env);

process.env.MAISTER_WORKTREES_ROOT = worktreesRoot;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/__tests__/**"],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/librarian-global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts$/ },
    {
      name: "librarian",
      dependencies: ["setup"],
      testMatch: process.env.MAISTER_LIBRARIAN_QUALIFY_ADAPTER
        ? /librarian-live\.spec\.ts$/
        : /librarian-acceptance\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
    },
  ],
  webServer: {
    command: "node e2e/librarian-web-server.mjs",
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DB_URL: resolvePostgresDbUrl(),
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me",
      MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-librarian-web"),
      MAISTER_WORKTREES_ROOT: worktreesRoot,
      MAISTER_SUPERVISOR_URL: LIBRARIAN_SUPERVISOR_URL,
      MAISTER_API_BASE_URL: baseURL,
      MAISTER_CRON_TOKEN: "librarian-e2e-cron-token",
      MAISTER_SCHEDULER_TIMER_ENABLED: "false",
      MAISTER_MAX_CONCURRENT_RUNS: "64",
      MAISTER_TEST_WEB_BUILD: "1",
      E2E_LIBRARIAN_WEB_PORT: String(port),
      E2E_LIBRARIAN_WEB_CONTROL_PORT: String(LIBRARIAN_WEB_CONTROL_PORT),
    },
  },
});
