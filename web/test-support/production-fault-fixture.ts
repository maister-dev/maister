import type { DatabaseFaultBarrier } from "./fault-barriers";
import type { RealSupervisor, RealSupervisorOptions } from "./real-supervisor";
import type { RealWeb } from "./real-web";
import type { StartedPostgresTestDb } from "./pg-container";
import type { SupervisorFaultProxy } from "./supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  seedAdmin,
  seedPlatformRunner,
  seedProjectRepo,
  seedFlowTask,
  WORKER_ADMIN,
} from "./durable-workers-seed";
import { startMainAndBrainPostgresTestDb } from "./pg-container";
import { startRealSupervisor } from "./real-supervisor";
import { signInWithCredentials, startRealWeb } from "./real-web";
import { startSupervisorFaultProxy } from "./supervisor-fault-proxy";
import { mkdtempReal } from "./worktree-test-root";
import { holdDatabaseWrite } from "./fault-barriers";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";

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
  tails(): Promise<{ web: string; supervisor: string }>;
  close(): Promise<void>;
};

/** One disposable production stack. Only HTTP drives domain transitions. */
export async function startProductionFaultFixture(
  options: {
    fixture?: string;
    fixtureArgs?: string[];
    fixtureEnv?: Record<string, string>;
  } = {},
): Promise<ProductionFaultFixture> {
  let database: StartedPostgresTestDb | undefined;
  let supervisor: RealSupervisor | undefined;
  let proxy: SupervisorFaultProxy | undefined;
  let web: RealWeb | undefined;
  const barriers: DatabaseFaultBarrier[] = [];

  async function close(): Promise<void> {
    const errors: unknown[] = [];

    for (const action of [
      () => web?.stop(),
      ...barriers.map((barrier) => () => barrier.close()),
      () => proxy?.close(),
      () => supervisor?.stop(),
      () => database?.stop(),
    ]) {
      try {
        await action();
      } catch (error) {
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
    database = await startMainAndBrainPostgresTestDb({
      databaseName: "s52_faults",
    });
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
        const response = await api("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: seeded.taskId }),
        });

        if (![200, 201, 202].includes(response.status))
          throw new Error(
            `flow launch ${response.status}: ${await response.text()}`,
          );
        const body = (await response.json()) as { runId?: string; id?: string };
        const runId = body.runId ?? body.id;

        if (!runId) throw new Error("flow launch omitted run ID");

        return runId;
      },
      async tails(): Promise<{ web: string; supervisor: string }> {
        return {
          web: await web!.logTail(4 * 1024 * 1024),
          supervisor: await supervisor!.logTail(4 * 1024 * 1024),
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
