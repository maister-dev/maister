// Global setup for the Stage A/B browser lane: boots a REAL supervisor
// (`supervisor/src/main.ts`, its own host-state store, the mock ACP adapter)
// on the lane's fixed port. Playwright starts the web server BEFORE this hook,
// so the web boots with the host unreachable and registers it lazily on the
// first launch — the same path a production web takes when its supervisor
// restarts. The returned function is the lane's teardown.
import { startRealSupervisor } from "../test-support/real-supervisor";

import { EXECUTION_AB_SUPERVISOR_PORT } from "./_seed/execution-ab-lane";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT;

  if (!worktreesRoot) {
    throw new Error(
      "execution-ab lane: MAISTER_WORKTREES_ROOT must be set by the config",
    );
  }
  const supervisor = await startRealSupervisor({
    port: EXECUTION_AB_SUPERVISOR_PORT,
    // The web adopts the worktree it creates under the lane's worktrees root.
    workspaceRoots: [worktreesRoot],
    fixtureArgs: ["--lines", "1"],
  });

  // eslint-disable-next-line no-console
  console.log(
    `[execution-ab] real supervisor pid ${supervisor.pid} on ${supervisor.url}; log ${supervisor.logFile}`,
  );

  return async () => {
    await supervisor.stop();
  };
}
