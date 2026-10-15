import type { LinuxIsolationPolicy } from "./linux-isolation";
import type { IsolationDriver } from "./process-isolation";
import type { RealSupervisor } from "./real-supervisor";
import type { ProductionWebBuild, RealWeb } from "./real-web";

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { seedAdmin, seedPlatformRunner } from "./durable-workers-seed";
import { prepareLinuxWebPolicy } from "./linux-web-policy";
import { startMainAndBrainPostgresTestDb } from "./pg-container";
import {
  assertInvocationGroupEmpty,
  findProcessIdentity,
  invocationFromEnvironment,
  invocationRecords,
  InvocationOwnershipError,
  logInvocation,
  sameProcess,
  signalInvocationGroup,
  type Invocation,
} from "./process-invocation";
import { startRealSupervisor } from "./real-supervisor";
import { buildProductionWeb, startRealWeb } from "./real-web";
import { mkdtempReal } from "./worktree-test-root";

export type LinuxLifecycleFixture = Readonly<{
  root: string;
  webRoot: string;
  worktreesRoot: string;
  sentinel: string;
  policy: LinuxIsolationPolicy;
  web: RealWeb;
  supervisor: RealSupervisor;
  close(): Promise<void>;
}>;

/** Production entrypoints over real migrated Postgres; I1–I4 own domain continuity. */
export async function startLinuxLifecycleFixture(
  driver: IsolationDriver,
  registerCleanup: (close: () => Promise<void>) => void,
): Promise<LinuxLifecycleFixture> {
  const context = invocationFromEnvironment();

  if (!context || driver.name !== "bubblewrap")
    throw new Error("Linux lifecycle controls require an owned namespace lane");
  const invocation: Invocation = context;
  const root = await mkdtempReal("maister-linux-lifecycle-");
  const webRoot = path.join(root, "web");
  const worktreesRoot = path.join(root, "worktrees");
  const supervisorRoot = path.join(root, "supervisor");
  const sentinel = path.join(supervisorRoot, "sentinel");
  const database = await startMainAndBrainPostgresTestDb({
    databaseName: "linux_lifecycle",
  });
  let supervisor: RealSupervisor | undefined;
  let web: RealWeb | undefined;
  let closing: Promise<void> | undefined;
  const buildLog = path.join(invocation.directory, "linux-lifecycle-build.log");

  async function stopBuild(): Promise<void> {
    for (const record of await invocationRecords(invocation)) {
      if (
        record.kind !== "process" ||
        record.role !== "build" ||
        record.logFile !== buildLog
      )
        continue;
      const current = await findProcessIdentity(
        invocation,
        record.identity.pid,
      );

      if (!current) continue;
      if (!sameProcess(current, record.identity))
        throw new InvocationOwnershipError(
          "lifecycle build identity changed before cleanup",
        );
      if (current.zombie) continue;
      await signalInvocationGroup(invocation, current.pgid, "SIGKILL");
      await assertInvocationGroupEmpty(invocation, current.pgid);
    }
  }

  async function release(): Promise<void> {
    const failures: unknown[] = [];
    const actions: ReadonlyArray<
      Readonly<{
        stage: string;
        close(): Promise<void> | undefined;
      }>
    > = [
      { stage: "build", close: stopBuild },
      { stage: "web", close: () => web?.kill() },
      { stage: "supervisor", close: () => supervisor?.stop() },
      { stage: "postgres", close: () => database.stop() },
      {
        stage: "root",
        close: () => rm(root, { recursive: true, force: true }),
      },
    ];

    for (const action of actions) {
      try {
        await action.close();
      } catch (error) {
        failures.push(error);
        logInvocation(invocation, "linux-lifecycle-cleanup-failed", {
          stage: action.stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Linux lifecycle fixture cleanup failed",
      );
  }

  function close(): Promise<void> {
    closing ??= release();

    return closing;
  }

  registerCleanup(close);

  try {
    await Promise.all(
      [webRoot, worktreesRoot, supervisorRoot].map((directory) =>
        mkdir(directory),
      ),
    );
    await writeFile(sentinel, "private-lifecycle-control");
    await seedAdmin(database.db);
    await seedPlatformRunner(database.db);
    supervisor = await startRealSupervisor({
      runtimeRoot: supervisorRoot,
      workspaceRoots: [worktreesRoot],
      fixtureArgs: ["--hang", "--supports-resume"],
    });
    const build: ProductionWebBuild | undefined = process.env
      .MAISTER_TEST_BUILT_WEB
      ? JSON.parse(process.env.MAISTER_TEST_BUILT_WEB)
      : undefined;

    if (!build) await buildProductionWeb(buildLog);
    if (closing)
      throw new Error("Linux lifecycle startup was cancelled during build");
    const state = path.join(supervisor.stateDir, "state.sqlite");
    const policy = await prepareLinuxWebPolicy({
      invocation,
      deniedRoots: [supervisorRoot],
      writableRoots: [webRoot, worktreesRoot],
      protectedFiles: [
        { path: sentinel },
        { path: state },
        { path: `${state}-wal`, optional: true },
        { path: `${state}-shm`, optional: true },
      ],
    });

    web = await startRealWeb({
      build,
      databaseUrl: database.databaseUrl,
      supervisorUrl: supervisor.url,
      runtimeRoot: webRoot,
      worktreesRoot,
      isolation: { driver, deniedRoots: [supervisorRoot], policy },
      env: { TSX_DISABLE_CACHE: "1" },
    });
    logInvocation(invocation, "linux-lifecycle-ready", {
      webPid: web.pid,
      supervisorPid: supervisor.pid,
      buildId: web.buildId,
    });

    return {
      root,
      webRoot,
      worktreesRoot,
      sentinel,
      policy,
      web,
      supervisor,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Linux lifecycle startup/cleanup failed",
      );
    }
    throw error;
  }
}
