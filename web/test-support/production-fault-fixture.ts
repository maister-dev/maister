import type { DatabaseFaultBarrier } from "./fault-barriers";
import type { RealSupervisor, RealSupervisorOptions } from "./real-supervisor";
import type { RealWeb } from "./real-web";
import type { StartedPostgresTestDb } from "./pg-container";
import type { SupervisorFaultProxy } from "./supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { getContainerRuntimeClient } from "testcontainers";

import {
  seedAdmin,
  seedPlatformRunner,
  seedProjectRepo,
  seedFlowTask,
  WORKER_ADMIN,
} from "./durable-workers-seed";
import { startMainAndBrainPostgresTestDbTemplate } from "./pg-container";
import { startRealSupervisor } from "./real-supervisor";
import { signInWithCredentials, startRealWeb } from "./real-web";
import { startSupervisorFaultProxy } from "./supervisor-fault-proxy";
import { mkdtempReal } from "./worktree-test-root";
import { holdDatabaseWrite } from "./fault-barriers";
import { launchFlowThroughHttp } from "./launch-flow-through-http";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";

const log = pino({ name: "production-fault-fixture" });
const POSTGRES_LOG_LIMIT_BYTES = 64 * 1024;

type PostgresFaultDiagnostics = {
  containerId: string;
  databaseName: string;
  capturedAt: string;
  state: {
    status: string;
    running: boolean;
    restarting: boolean;
    oomKilled: boolean;
    dead: boolean;
    exitCode: number;
    error: string;
    startedAt: string;
    finishedAt: string;
  };
  restartCount: number;
  logBytes: number;
  logTruncated: boolean;
  logTail: string;
};

function postgresLogTail(bytes: Buffer): {
  logBytes: number;
  logTruncated: boolean;
  logTail: string;
} {
  let offset = 0;
  let logBytes = 0;
  let retained = Buffer.alloc(0);

  while (offset < bytes.length) {
    if (
      bytes.length - offset < 8 ||
      (bytes[offset] !== 1 && bytes[offset] !== 2) ||
      bytes[offset + 1] !== 0 ||
      bytes[offset + 2] !== 0 ||
      bytes[offset + 3] !== 0
    )
      throw new Error("PostgreSQL Docker log snapshot has an invalid frame");
    const length = bytes.readUInt32BE(offset + 4);
    const end = offset + 8 + length;

    if (end > bytes.length)
      throw new Error("PostgreSQL Docker log snapshot has an incomplete frame");
    logBytes += length;
    const payload = bytes.subarray(
      Math.max(offset + 8, end - POSTGRES_LOG_LIMIT_BYTES),
      end,
    );
    const combined = Buffer.concat([
      new Uint8Array(retained),
      new Uint8Array(payload),
    ]);

    retained = combined.subarray(
      Math.max(0, combined.length - POSTGRES_LOG_LIMIT_BYTES),
    );
    offset = end;
  }

  return {
    logBytes,
    logTruncated: logBytes > retained.length,
    logTail: retained.toString("utf8"),
  };
}

async function postgresDiagnostics(
  database: StartedPostgresTestDb,
): Promise<PostgresFaultDiagnostics> {
  const containerId = database.container.getId();
  const runtime = await getContainerRuntimeClient();
  const container = runtime.container.getById(containerId);
  const abortSignal = AbortSignal.timeout(3_000);
  const [inspection, bytes] = await Promise.all([
    container.inspect({ abortSignal }),
    container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: true,
      abortSignal,
    }),
  ]);

  if (inspection.Id !== containerId)
    throw new Error("PostgreSQL diagnostic container identity differs");

  return {
    containerId,
    databaseName: decodeURIComponent(
      new URL(database.databaseUrl).pathname.slice(1),
    ),
    capturedAt: new Date().toISOString(),
    state: {
      status: inspection.State.Status,
      running: inspection.State.Running,
      restarting: inspection.State.Restarting,
      oomKilled: inspection.State.OOMKilled,
      dead: inspection.State.Dead,
      exitCode: inspection.State.ExitCode,
      error: inspection.State.Error,
      startedAt: inspection.State.StartedAt,
      finishedAt: inspection.State.FinishedAt,
    },
    restartCount: inspection.RestartCount,
    ...postgresLogTail(bytes),
  };
}

export type ProductionFaultFixture = {
  database: StartedPostgresTestDb;
  proxy: SupervisorFaultProxy;
  root: string;
  projectId: string;
  adapterLog: string;
  cookie: string;
  readonly supervisor: RealSupervisor;
  readonly web: RealWeb;
  api(route: string, init?: RequestInit): Promise<Response>;
  requestSweep(): Promise<Response>;
  restartWeb(): Promise<RealWeb>;
  restartSupervisor(
    overrides?: Partial<RealSupervisorOptions>,
  ): Promise<RealSupervisor>;
  holdWrite(
    input: Omit<Parameters<typeof holdDatabaseWrite>[0], "pool">,
  ): Promise<DatabaseFaultBarrier>;
  launchScratch(prompt?: string): Promise<string>;
  launchFlow(): Promise<string>;
  tails(): Promise<{
    web: string;
    supervisor: string;
    postgres: PostgresFaultDiagnostics;
  }>;
  close(): Promise<void>;
};

type ProductionFaultOptions = {
  fixture?: string;
  fixtureArgs?: string[];
  fixtureEnv?: Record<string, string>;
};

export type ProductionFaultSuite = {
  startFixture(
    options?: ProductionFaultOptions,
  ): Promise<ProductionFaultFixture>;
  stop(): Promise<void>;
};

/** Migrate once per suite; every stack receives its own unseeded database. */
export async function startProductionFaultSuite(): Promise<ProductionFaultSuite> {
  const template = await startMainAndBrainPostgresTestDbTemplate({
    databaseName: "s52_faults",
  });

  return {
    startFixture: async (options = {}) =>
      startProductionFaultFixture(await template.createDatabase(), options),
    stop: () => template.stop(),
  };
}

/** One disposable production stack. Only HTTP drives domain transitions. */
async function startProductionFaultFixture(
  database: StartedPostgresTestDb,
  options: ProductionFaultOptions,
): Promise<ProductionFaultFixture> {
  let supervisor: RealSupervisor | undefined;
  let proxy: SupervisorFaultProxy | undefined;
  let web: RealWeb | undefined;
  const barriers: DatabaseFaultBarrier[] = [];

  async function close(): Promise<void> {
    const errors: unknown[] = [];

    const actions: { stage: string; close: () => Promise<void> | undefined }[] =
      [
        { stage: "web", close: () => web?.stop() },
        ...barriers.map((barrier, index) => ({
          stage: `database-barrier-${index}`,
          close: () => barrier.close(),
        })),
        { stage: "proxy", close: () => proxy?.close() },
        { stage: "supervisor", close: () => supervisor?.stop() },
        { stage: "database", close: () => database.stop() },
      ];

    for (const action of actions) {
      try {
        await action.close();
      } catch (error) {
        log.error(
          {
            err: error,
            stage: action.stage,
            caseName: process.env.MAISTER_TEST_CASE_NAME,
          },
          "production fault fixture cleanup failed",
        );
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "production fault fixture cleanup failed",
      );
  }
  try {
    const root = await mkdtempReal("s52-fault-");
    const adapterLog = path.join(root, "adapter-invocations.ndjson");
    const cronToken = randomUUID();
    const worktreesRoot = path.join(root, "worktrees");

    await mkdir(worktreesRoot);
    supervisor = await startRealSupervisor({
      runtimeRoot: path.join(root, "host"),
      workspaceRoots: [root, worktreesRoot],
      fixture: options.fixture,
      fixtureArgs: options.fixture
        ? options.fixtureArgs
        : [
            "--hang",
            "--supports-resume",
            "--invocation-log",
            adapterLog,
            ...(options.fixtureArgs ?? []),
          ],
      env: options.fixtureEnv,
    });
    proxy = await startSupervisorFaultProxy(supervisor.url);
    await seedAdmin(database.db);
    await seedPlatformRunner(database.db);
    const { projectId } = await seedProjectRepo(database.db, root);

    await database.pool
      .query(`CREATE TABLE s52_application_audit(command_id text, owner text, old_applied timestamptz);
      CREATE FUNCTION s52_audit_apply() RETURNS trigger LANGUAGE plpgsql AS $audit$
      BEGIN IF NEW.completion_applied_at IS NOT NULL AND NEW.completion_applied_at IS DISTINCT FROM OLD.completion_applied_at THEN
        INSERT INTO s52_application_audit VALUES(NEW.id, OLD.application_claim_owner, OLD.completion_applied_at);
      END IF; RETURN NEW; END $audit$;
      CREATE TRIGGER s52_audit_apply AFTER UPDATE ON execution_commands FOR EACH ROW EXECUTE FUNCTION s52_audit_apply()`);
    web = await startRealWeb({
      databaseUrl: database.databaseUrl,
      supervisorUrl: proxy.url,
      runtimeRoot: path.join(root, "web"),
      worktreesRoot,
      env: { MAISTER_CRON_TOKEN: cronToken },
    });
    const cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
    const api = (route: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${web!.url}${route}`, {
        ...init,
        headers: { ...init.headers, cookie },
      });

    return {
      database,
      proxy,
      root,
      projectId,
      adapterLog,
      cookie,
      get supervisor(): RealSupervisor {
        return supervisor!;
      },
      get web(): RealWeb {
        return web!;
      },
      api,
      requestSweep(): Promise<Response> {
        return api("/api/cron/gc", {
          method: "POST",
          headers: { "X-Maister-Cron-Token": cronToken },
        });
      },
      async restartWeb(): Promise<RealWeb> {
        web = await web!.restart();

        return web;
      },
      async restartSupervisor(
        overrides?: Partial<RealSupervisorOptions>,
      ): Promise<RealSupervisor> {
        supervisor = await supervisor!.restart(overrides);

        return supervisor;
      },
      async holdWrite(
        input: Omit<Parameters<typeof holdDatabaseWrite>[0], "pool">,
      ): Promise<DatabaseFaultBarrier> {
        const barrier = await holdDatabaseWrite({
          ...input,
          pool: database!.pool,
        });

        barriers.push(barrier);

        return barrier;
      },
      async launchScratch(
        prompt = 'fixture-output:{"bytes":0,"text":"partition result"}',
      ): Promise<string> {
        const response = await api("/api/scratch-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId,
            baseBranch: "main",
            name: `fault-${randomUUID()}`,
            prompt,
            reasoningEffort: "high",
            attachments: [],
          }),
        });

        if (response.status !== 200)
          throw new Error(
            `scratch launch ${response.status}: ${await response.text()}`,
          );

        return (await readLaunchResult(response)).runId;
      },
      async launchFlow(): Promise<string> {
        const seeded = await seedFlowTask(database!.db, {
          projectId,
          installedPath: root,
          terminalDelayMs: 0,
        });

        return launchFlowThroughHttp({
          api,
          origin: web!.url,
          taskId: seeded.taskId,
        });
      },
      async tails(): Promise<{
        web: string;
        supervisor: string;
        postgres: PostgresFaultDiagnostics;
      }> {
        const [webLog, supervisorLog, postgres] = await Promise.all([
          web!.logTail(4 * 1024 * 1024),
          supervisor!.logTail(4 * 1024 * 1024),
          postgresDiagnostics(database),
        ]);

        log.error(
          { postgres },
          "production fault fixture PostgreSQL diagnostics",
        );

        return {
          web: webLog,
          supervisor: supervisorLog,
          postgres,
        };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "fault fixture startup failed",
      );
    }
    throw error;
  }
}
