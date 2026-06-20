import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { E2E_DB_URL } from "./e2e/_seed/db-url";
import { STUB_SUPERVISOR_URL } from "./e2e/_seed/stub-supervisor";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const AUTH_SECRET =
  process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me";
// M19: the GET|POST /api/cron/gc route authenticates against MAISTER_CRON_TOKEN.
// Pinned here (and re-read by e2e/m19-reconcile-gc.spec.ts via process.env) so
// the cron auth-gate scenario can assert no-token→503, wrong-token→401,
// valid-token→200/207 deterministically.
const MAISTER_CRON_TOKEN =
  process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";
// outbound-webhooks.spec.ts: the value behind a subscription's
// `signing_secret_ref = env:WH_E2E_SECRET`. The webhook drain resolves this env
// var SERVER-SIDE at send time, so it must live in the webServer process env
// below; the spec's in-process stub re-derives the HMAC from the SAME value to
// verify each captured signature. Re-read by the spec via process.env.
const WH_E2E_SECRET = process.env.WH_E2E_SECRET ?? "whsec_e2e_0123456789abcdef";
const AUTH_FILE = "e2e/.auth/admin.json";
const AUTHED_SPEC =
  /.*(active-workspaces|m11[abc]-.*|m12-evidence-graph|m13-assignments|m15-.*|m16-.*|m17-.*|m18-.*|m19-.*|m22-.*|m23-.*|m27-.*|multi-run-cost-policy|run-task-context|portfolio-board|task-launch-gating|project-registration|project-onboarding|admin-users|project-members|review-comments|review-diff-scopes|gate-chat|social-board|scratch-launch|scratch-detail|scratch-composer|platform-acp-runners|model-suggestions|flows-authoring|flow-editor|run-schedules|flow-package-viewer|flow-studio-artifacts|outbound-webhooks|package-management|platform-agents-.*|inbox|mcps|studio-local-edit|studio-package-viewer|studio-import|studio)\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Local retries absorb residual cross-test interference on the ONE shared
  // e2e DB (CI already retries 2); a deterministic regression still fails.
  retries: process.env.CI ? 2 : 1,
  // The local suite runs against ONE dev-mode Next server; the per-core
  // default (8 workers on 16 cores) thrashes route compiles into timeout
  // flakes. CI keeps Playwright's default.
  workers: process.env.CI ? undefined : 4,
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
    // M11a/M11b/M11c + portfolio/launch/registration/admin/scratch/platform specs run as
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
      MAISTER_WORKTREES_ROOT: path.resolve("e2e/.runtime/worktrees"),
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
      // M19 cron-gc auth gate (see e2e/m19-reconcile-gc.spec.ts). Also gates the
      // outbound-webhooks drain trigger (POST /api/cron/tick).
      MAISTER_CRON_TOKEN,
      // outbound-webhooks.spec.ts: server-side signing secret behind
      // `env:WH_E2E_SECRET` (resolved at webhook send time).
      WH_E2E_SECRET,
      // outbound-webhooks.spec.ts: the spec's consumer stub binds 127.0.0.1,
      // which the SSRF egress policy blocks — exempt it the way an operator
      // exempts a local consumer.
      MAISTER_WEBHOOK_ALLOW_HOSTS: "127.0.0.1",
    },
  },
});
