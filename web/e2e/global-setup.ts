// Playwright global setup for the authenticated/seeded e2e suite. Database
// preflight runs from the webServer command because Playwright starts the server
// before this hook. Auth (storageState) is handled by e2e/auth.setup.ts.
import { Pool } from "pg";

import { E2E_DB_URL } from "./_seed/db-url";
import {
  STUB_SESSIONS_DIR,
  STUB_SUPERVISOR_PORT,
} from "./_seed/stub-supervisor";
import { startTestSupervisor } from "./_seed/test-supervisor";

// The delegate-target worker agent the orchestrator-loop spec's coordinator
// delegates each child to (must match seed-e2e.ts E2E_WORKER_AGENT).
const E2E_WORKER_AGENT = "e2e-orc-pkg:e2e-worker";

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Playwright starts webServer before global setup. The webServer command runs
  // e2e/prepare.ts first, so the migration boot guard sees the seeded schema.

  // The test supervisor must be up before auth and the test projects start: it
  // answers /health ready (the M11c launch-refusal + board Launch
  // gate), serves the stub-compat /sessions hold-until-`.release` path for the
  // platform-agents `agent` specs, AND drives the M37 orchestrator
  // delegate→park→resume loop for the orchestrator-loop spec (its coordinator
  // session spawns children through the REAL ext delegate HTTP route). It binds
  // STUB_SUPERVISOR_PORT so playwright.config.ts's MAISTER_SUPERVISOR_URL
  // (=STUB_SUPERVISOR_URL) reaches it unchanged. Returned as the global teardown.
  process.env.MAISTER_TEST_CHILD_AGENT_ID = E2E_WORKER_AGENT;
  const supervisorPool = new Pool({ connectionString: E2E_DB_URL });
  const supervisor = await startTestSupervisor({
    pool: supervisorPool,
    portHint: STUB_SUPERVISOR_PORT,
    childCount: 2,
    stubCompat: { sessionsDir: STUB_SESSIONS_DIR },
  });

  return async () => {
    await supervisor.stop();
    await supervisorPool.end();
  };
}
