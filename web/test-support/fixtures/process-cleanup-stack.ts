import { mkdir } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "../pg-container";
import { invocationFromEnvironment } from "../process-invocation";
import { startRealSupervisor, type RealSupervisor } from "../real-supervisor";
import {
  startRealWeb,
  type ProductionWebBuild,
  type RealWeb,
} from "../real-web";
import { mkdtempReal } from "../worktree-test-root";

export async function startReadyRealFixtureStack(): Promise<{
  database: StartedPostgresTestDb;
  supervisor: RealSupervisor;
  web: RealWeb;
}> {
  const build = JSON.parse(
    process.env.MAISTER_TEST_BUILT_WEB ?? "null",
  ) as ProductionWebBuild | null;

  if (!build)
    throw new Error("cleanup control requires the outer verified build");
  const database = await startMainAndBrainPostgresTestDb({
    databaseName: "s52_cleanup",
  });
  const base = await mkdtempReal("s52-cleanup-stack-");
  const webRoot = path.join(base, "web");
  const worktreesRoot = path.join(base, "worktrees");

  await mkdir(webRoot);
  await mkdir(worktreesRoot);
  const supervisor = await startRealSupervisor();
  const web = await startRealWeb({
    build,
    databaseUrl: database.databaseUrl,
    supervisorUrl: supervisor.url,
    runtimeRoot: webRoot,
    worktreesRoot,
  });
  const socket = connect(
    Number(process.env.MAISTER_TEST_CLEANUP_CONTROL_PORT),
    "127.0.0.1",
  );

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.end(
        JSON.stringify({
          workerPid: process.pid,
          supervisorPid: supervisor.pid,
          webPid: web.pid,
          invocation: invocationFromEnvironment(),
          containerId: database.container.getId(),
        }),
        resolve,
      ),
    );
  });

  return { database, supervisor, web };
}

export async function holdRealFixtureStack(): Promise<never> {
  await startReadyRealFixtureStack();

  // The outer owner kills a named PID after real HTTP readiness.
  return new Promise<never>(() => {});
}
