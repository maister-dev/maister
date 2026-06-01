import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { E2E_DB_URL } from "./e2e/_seed/db-url";
import { STUB_SUPERVISOR_URL } from "./e2e/_seed/stub-supervisor";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const AUTH_SECRET =
  process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me";
const AUTH_FILE = "e2e/.auth/admin.json";
const AUTHED_SPEC =
  /.*(m11[abc]-.*|portfolio-board|task-launch-gating|project-registration|admin-users|scratch-launch)\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    // Signs the seeded admin in and saves storageState for the authed project.
    { name: "setup", testMatch: /.*\.setup\.ts$/ },
    // Unauthenticated specs (login/redirect/i18n) — no storageState.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [/.*\.setup\.ts$/, AUTHED_SPEC, /live-.*\.spec\.ts$/],
    },
    // M11a/M11b/M11c + portfolio/launch/registration/admin/scratch specs run as
    // the seeded admin against the dedicated e2e DB, each against its OWN
    // per-spec seeded project/run/worktree fixture.
    {
      name: "authed",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_FILE },
      dependencies: ["setup"],
      testMatch: AUTHED_SPEC,
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DB_URL: E2E_DB_URL,
      AUTH_SECRET,
      MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime"),
      // Points at the e2e stub supervisor (global-setup), which answers ONLY
      // `GET /health` ready and implements NOTHING else. It is NOT a real
      // supervisor: no `/sessions`, no agent spawn. The m11a rework decision and
      // the m11b takeover resume schedule a background runFlow that must not
      // reach a real supervisor — neither resume path hits an ai_coding/judge
      // node, so none calls `/sessions` and the stub stays a no-op for them. The
      // M11c launch-refusal scenario needs `/health` ready so the board Launch
      // button is enabled and POST /api/runs gets PAST the health check to the
      // settings-enforcement gate (which is what refuses with CONFIG 400).
      MAISTER_SUPERVISOR_URL: STUB_SUPERVISOR_URL,
    },
  },
});
