import type { Run } from "@/lib/db/schema";
import type { ReconcileSweepSummary } from "@/lib/reconcile";
import type { Db } from "@/lib/execution-host/db";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { SeededGraphRun } from "@/test-support/graph-run-seed";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { fork, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runs, nodeAttempts, executionCommands } from "@/lib/db/schema";
import {
  createExecutionHosts,
  localHost,
  mintPlacement,
} from "@/lib/execution-host";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { stopCanonicalProjectionWorker } from "@/lib/execution-host/events/projection-runtime";
import {
  claimFlowDriver,
  renewFlowDriverClaim,
  releaseFlowDriverClaim,
  FlowDriverClaimLost,
} from "@/lib/flows/graph/driver-claim";
import { runFlow } from "@/lib/flows/runner";
import { runReconcileSweep } from "@/lib/reconcile";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { initRepoWithWorktree } from "@/test-support/git-fixture";
import { poll } from "@/test-support/durable-workers-ledger";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let database: StartedPostgresTestDb;
let supervisor: RealSupervisor;
let db: Db;
let restoreUrl: () => void;
let priorDbUrl: string | undefined;
let priorGrace: string | undefined;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "r9_cli_driver" });
  db = database.db as unknown as Db;
  supervisor = await startRealSupervisor({ fixtureArgs: ["--lines", "0"] });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  priorDbUrl = process.env.DB_URL;
  priorGrace = process.env.MAISTER_RECONCILE_GRACE_SECONDS;
  process.env.DB_URL = database.databaseUrl;
  process.env.MAISTER_RECONCILE_GRACE_SECONDS = "1";
  resetResolverForTests();
  resetRegistrarStateForTests();
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await stopCanonicalProjectionWorker();
  restoreUrl?.();
  if (priorDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = priorDbUrl;
  if (priorGrace === undefined)
    delete process.env.MAISTER_RECONCILE_GRACE_SECONDS;
  else process.env.MAISTER_RECONCILE_GRACE_SECONDS = priorGrace;
  await supervisor?.kill();
  await database?.stop();
});

async function seedCli(
  nodesAfterWork: FlowYamlV1["nodes"] = [],
): Promise<SeededGraphRun> {
  const name = `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await initRepoWithWorktree(supervisor.runtimeRoot, name);
  const seeded = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "C1",
      nodes: [
        {
          id: "work",
          type: "cli",
          action: {
            command:
              "printf '%s' \"$$\" > cli-ready; while [ ! -f cli-release ]; do sleep 0.1; done; printf 'done'",
          },
          transitions: { success: nodesAfterWork[0]?.id ?? "done" },
        },
        ...nodesAfterWork,
      ],
    },
    {
      repoPath: workspace.repoPath,
      workspace: { ...workspace, parentRepoPath: workspace.repoPath },
    },
  );
  const host = await localHost({ db });

  await db.transaction((tx) =>
    mintPlacement(tx, { runId: seeded.runId, host, reason: "launch" }),
  );

  return seeded;
}

async function readRun(runId: string): Promise<Run> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run) throw new Error("CLI fixture run missing");

  return run;
}

async function ready(seeded: SeededGraphRun): Promise<number> {
  return poll(
    async () => {
      try {
        const value = Number(
          await readFile(path.join(seeded.worktreePath, "cli-ready"), "utf8"),
        );

        return Number.isSafeInteger(value) && value > 0 ? value : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    30_000,
    "real CLI process ready",
  );
}

function startDriver(seeded: SeededGraphRun): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support/flow-prompt-owner-process.ts"),
    [seeded.runId, supervisor.runtimeRoot],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  return { child, exited, output: () => output };
}

async function releaseCli(seeded: SeededGraphRun): Promise<void> {
  await writeFile(path.join(seeded.worktreePath, "cli-release"), "release");
}

function killCli(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function sweep(): Promise<ReconcileSweepSummary> {
  const dispatch = vi.fn(async (_id: string) => {});
  const summary = await runReconcileSweep({
    db,
    executionHosts: createExecutionHosts({ db }),
    runFlow: dispatch,
  });

  expect(dispatch).not.toHaveBeenCalled();

  return summary;
}

describe("C1 real CLI driver ownership", () => {
  it("preserves and renews a same-process CLI-only driver without an ACP session", async () => {
    const seeded = await seedCli();
    const controller = new AbortController();
    const work = runFlow(seeded.runId, {
      db,
      runtimeRoot: supervisor.runtimeRoot,
      signal: controller.signal,
    });

    try {
      await ready(seeded);
      const first = await readRun(seeded.runId);

      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Running");
      expect(first.flowDriverToken).toBeTruthy();
      expect(
        await db
          .select({ id: executionCommands.id })
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.create"),
            ),
          ),
      ).toHaveLength(0);
      await poll(
        async () => {
          const current = await readRun(seeded.runId);

          return current.flowDriverLeaseExpiresAt &&
            first.flowDriverLeaseExpiresAt &&
            current.flowDriverLeaseExpiresAt > first.flowDriverLeaseExpiresAt
            ? current
            : null;
        },
        15_000,
        "actual driver lease renewal",
      );
      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Running");
      await releaseCli(seeded);
      await work;
      expect((await readRun(seeded.runId)).flowDriverToken).toBeNull();
    } finally {
      controller.abort();
      await releaseCli(seeded);
      await work;
    }
  }, 60_000);

  it.each(["cli-only", "mixed"] as const)(
    "preserves a %s driver observed from another web process",
    async (kind) => {
      const seeded = await seedCli(
        kind === "mixed"
          ? [
              {
                id: "agent",
                type: "ai_coding",
                action: { prompt: "complete" },
                transitions: { success: "done" },
              },
            ]
          : [],
      );
      const driver = startDriver(seeded);
      let pid: number | undefined;

      try {
        pid = await ready(seeded);
        expect((await readRun(seeded.runId)).flowDriverToken).toBeTruthy();
        await sweep();
        expect((await readRun(seeded.runId)).status).toBe("Running");
        await releaseCli(seeded);
        expect(await driver.exited, driver.output()).toBe(0);
        expect((await readRun(seeded.runId)).flowDriverToken).toBeNull();
      } finally {
        driver.child.kill("SIGKILL");
        if (pid) killCli(pid);
        await driver.exited;
      }
    },
    60_000,
  );

  it("crashes a genuinely killed driver after lease and grace, without unsafe Recover", async () => {
    const seeded = await seedCli();
    const driver = startDriver(seeded);
    let pid: number | undefined;

    try {
      pid = await ready(seeded);
      driver.child.kill("SIGKILL");
      await driver.exited;
      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Running");
      await database.pool.query(
        "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.1) FROM runs WHERE id = $1",
        [seeded.runId],
      );
      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Crashed");
      await expect(
        resumeCrashedRun(seeded.runId, {
          db,
          executionHosts: createExecutionHosts({ db }),
        }),
      ).resolves.toEqual({ state: "discard-only" });
      const attempts = await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));

      expect(attempts).toHaveLength(1);
    } finally {
      driver.child.kill("SIGKILL");
      if (pid) killCli(pid);
      await driver.exited;
      await db
        .update(runs)
        .set({ status: "Abandoned" })
        .where(eq(runs.id, seeded.runId));
    }
  }, 60_000);

  it("rechecks a claim won while reconcile waits for the run lock", async () => {
    const seeded = await seedCli();

    await db
      .update(runs)
      .set({ currentStepId: "work", startedAt: new Date(0) })
      .where(eq(runs.id, seeded.runId));
    const run = await readRun(seeded.runId);
    const blocker = await database.pool.connect();
    let claim: Awaited<ReturnType<typeof claimFlowDriver>> = null;
    let sweepResult: Promise<unknown> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [
        seeded.runId,
      ]);
      const claiming = claimFlowDriver(db, {
        runId: seeded.runId,
        assignmentId: run.executionAssignmentId!,
      });

      await poll(
        async () =>
          (
            await database.pool.query(
              "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%runs%'",
            )
          ).rows.length
            ? true
            : null,
        5000,
        "claim waiting on run lock",
      );
      sweepResult = sweep();
      await poll(
        async () =>
          (
            await database.pool.query(
              "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%runs%'",
            )
          ).rows.length >= 2
            ? true
            : null,
        5000,
        "reconcile queued behind claim",
      );
      await blocker.query("COMMIT");
      claim = await claiming;
      await sweepResult;
      expect((await readRun(seeded.runId)).status).toBe("Running");
      expect((await readRun(seeded.runId)).flowDriverToken).toBe(claim?.token);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await sweepResult;
      if (claim) await releaseFlowDriverClaim(db, claim);
      await db
        .update(runs)
        .set({ status: "Abandoned" })
        .where(eq(runs.id, seeded.runId));
    }
  }, 30_000);

  it("preserves a successor claimed behind a stale reconcile observation and rejects predecessor writes", async () => {
    const seeded = await seedCli();

    await db
      .update(runs)
      .set({ currentStepId: "work", startedAt: new Date(0) })
      .where(eq(runs.id, seeded.runId));
    const firstRun = await readRun(seeded.runId);
    const first = await claimFlowDriver(db, {
      runId: seeded.runId,
      assignmentId: firstRun.executionAssignmentId!,
    });

    if (!first) throw new Error("first CLI claim missing");
    await db
      .update(runs)
      .set({ flowDriverLeaseExpiresAt: new Date(0) })
      .where(eq(runs.id, seeded.runId));
    const host = await localHost({ db });
    const blocker = await database.pool.connect();
    let second: Awaited<ReturnType<typeof claimFlowDriver>> = null;
    let replacement:
      | Promise<Awaited<ReturnType<typeof claimFlowDriver>>>
      | undefined;
    let sweepResult: Promise<unknown> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [
        seeded.runId,
      ]);
      replacement = db
        .transaction((tx) =>
          mintPlacement(tx, {
            runId: seeded.runId,
            host,
            reason: "resume",
          }),
        )
        .then((next) =>
          claimFlowDriver(db, {
            runId: seeded.runId,
            assignmentId: next.id,
          }),
        );
      await poll(
        async () =>
          (
            await database.pool.query(
              "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%runs%'",
            )
          ).rows.length
            ? true
            : null,
        5000,
        "successor placement waiting",
      );
      sweepResult = sweep();
      await poll(
        async () =>
          (
            await database.pool.query(
              "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%runs%'",
            )
          ).rows.length >= 2
            ? true
            : null,
        5000,
        "stale reconcile queued behind replacement",
      );
      await blocker.query("COMMIT");
      second = await replacement;
      await sweepResult;
      if (!second) throw new Error("successor CLI claim missing");
      expect((await readRun(seeded.runId)).status).toBe("Running");
      await expect(renewFlowDriverClaim(db, first)).rejects.toThrow(
        FlowDriverClaimLost,
      );
      await releaseFlowDriverClaim(db, first);
      expect((await readRun(seeded.runId)).flowDriverToken).toBe(second.token);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      second ??= (await replacement) ?? null;
      await sweepResult;
      if (second) await releaseFlowDriverClaim(db, second);
      await db
        .update(runs)
        .set({ status: "Abandoned" })
        .where(eq(runs.id, seeded.runId));
    }
  }, 30_000);

  it("retains grace for an unclaimed fresh CLI entry, then crashes without redispatch", async () => {
    const seeded = await seedCli();

    await db
      .update(runs)
      .set({ currentStepId: "work", resumeStartedAt: new Date() })
      .where(eq(runs.id, seeded.runId));
    try {
      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Running");
      await database.pool.query(
        "SELECT pg_sleep(greatest(0, 1.05 - extract(epoch from clock_timestamp() - resume_started_at))) FROM runs WHERE id = $1",
        [seeded.runId],
      );
      await sweep();
      expect((await readRun(seeded.runId)).status).toBe("Crashed");
    } finally {
      await db
        .update(runs)
        .set({ status: "Abandoned" })
        .where(eq(runs.id, seeded.runId));
    }
  });
});
