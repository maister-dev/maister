// B6 (ADR-177 amendment 2026-09-26), T4.1: every terminal writer names WHY in
// its event's typed `cause` — the emitter rows the paired-emission suites do
// not already drive. Each case asserts the VALUES of one D-B2 row; presence is
// the compile-time discriminant's job (`taxonomy.test.ts`).

import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import {
  crashRunningRun,
  crashWaitingOnChildren,
  markAbandoned,
} from "@/lib/runs/state-transitions";
import {
  markScratchCrashed,
  stopScratchWorkbench,
} from "@/lib/scratch-runs/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "terminal_cause_emit",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedProject(): Promise<{ projectId: string; runnerId: string }> {
  const projectId = randomUUID();
  const runnerId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `cause-${projectId.slice(0, 8)}`,
    name: "Cause",
    taskKey: `C${projectId.slice(0, 7)}`.toUpperCase(),
    repoPath: `/tmp/cause-${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  return { projectId, runnerId };
}

async function seedFlowRun(status: string): Promise<string> {
  const { projectId, runnerId } = await seedProject();
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runnerId,
    capabilityAgent: "claude",
    flowVersion: "v1",
    status,
    currentStepId: "implement",
  });

  return runId;
}

async function seedScratchRun(): Promise<string> {
  const { projectId, runnerId } = await seedProject();
  const runId = randomUUID();
  const userId = randomUUID();

  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId.slice(0, 8)}@test.local` });
  await db.insert(schema.runs).values({
    id: runId,
    runKind: "scratch",
    projectId,
    runnerId,
    capabilityAgent: "claude",
    flowVersion: "scratch",
    status: "Running",
  });
  await db.insert(schema.scratchRuns).values({
    runId,
    projectId,
    createdByUserId: userId,
    initialPrompt: "do the thing",
    baseBranch: "main",
    baseCommit: "deadbeef",
    dialogStatus: "Running",
  });

  return runId;
}

async function newestPayload(
  runId: string,
  kind: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ payload: schema.domainEvents.payload })
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, kind),
      ),
    )
    .orderBy(desc(schema.domainEvents.id))
    .limit(1);

  return row.payload as Record<string, unknown>;
}

describe("the terminal cause on each writer (D-B2)", () => {
  it("crashWaitingOnChildren: CRASH, the crash reason as a token, from the sweep", async () => {
    const runId = await seedFlowRun("WaitingOnChildren");

    expect(
      (await crashWaitingOnChildren(runId, "orchestrator-stuck", { db })).ok,
    ).toBe(true);
    expect((await newestPayload(runId, "run.crashed")).cause).toEqual({
      code: "CRASH",
      reason: "orchestrator_stuck",
      source: "reconcile",
    });
  });

  it("crashRunningRun from an owner application names the graph as the source", async () => {
    const runId = await seedFlowRun("Running");

    expect(
      (
        await crashRunningRun(runId, "session-crashed", {
          db,
          causeSource: "graph",
        })
      ).ok,
    ).toBe(true);
    expect((await newestPayload(runId, "run.crashed")).cause).toEqual({
      code: "CRASH",
      reason: "session_crashed",
      source: "graph",
    });
  });

  it("markAbandoned by the reconcile orphan arm: the truth rides cause, the legacy reason is untouched", async () => {
    const runId = await seedFlowRun("Pending");

    expect(
      (
        await markAbandoned(runId, {
          db,
          cause: { code: null, reason: "orphan", source: "reconcile" },
        })
      ).ok,
    ).toBe(true);
    const payload = await newestPayload(runId, "run.abandoned");

    expect(payload.reason).toBe("user");
    expect(payload.cause).toEqual({
      code: null,
      reason: "orphan",
      source: "reconcile",
    });
  });

  it("markScratchCrashed: the error's code and reason, from the scratch dialog", async () => {
    const runId = await seedScratchRun();

    await markScratchCrashed({
      db: db as never,
      runId,
      err: new MaisterError("CRASH", "reconcile: agent-session-gone", {
        details: { reason: "agent-session-gone" },
      }),
    });
    expect((await newestPayload(runId, "run.crashed")).cause).toEqual({
      code: "CRASH",
      reason: "agent_session_gone",
      source: "scratch",
    });
  });

  it("markScratchCrashed as a budget kill: run.failed with BUDGET_EXCEEDED", async () => {
    const runId = await seedScratchRun();

    await markScratchCrashed({
      db: db as never,
      runId,
      err: new MaisterError("BUDGET_EXCEEDED", "budget", {
        details: { reason: "budget_breach" },
      }),
      terminal: "failed",
    });
    expect((await newestPayload(runId, "run.failed")).cause).toEqual({
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "scratch",
    });
  });

  it("a scratch stop that abandons the run emits run.abandoned (it emitted nothing before)", async () => {
    const runId = await seedScratchRun();

    expect(
      await stopScratchWorkbench(runId, { db: db as never }),
    ).toMatchObject({ runStatus: "Abandoned" });
    expect((await newestPayload(runId, "run.abandoned")).cause).toEqual({
      code: null,
      reason: "stop",
      source: "operator",
    });
  });

  // Two operators stop the same dialog at once: both pass the unlocked
  // pre-check, and the second must find it ended under the lock — or the
  // event's consumers (memory harvest, agent triggers) fire twice.
  it("two concurrent stops emit run.abandoned exactly once", async () => {
    const runId = await seedScratchRun();
    // Hold the run row so both stops pass the pre-check and park on the lock
    // before either can end the dialog: the window the guard closes.
    const blocker = await testDatabase.pool.connect();
    let committed = false;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [
        runId,
      ]);
      const racers = Promise.all([
        stopScratchWorkbench(runId, { db: db as never }),
        stopScratchWorkbench(runId, { db: db as never }),
      ]);
      const deadline = Date.now() + 30_000;

      for (;;) {
        const { rows } = await testDatabase.pool.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM runs WHERE id%FOR UPDATE%'`,
        );

        if (rows[0].waiting >= 2) break;
        if (Date.now() > deadline)
          throw new Error("both stops never parked on the run lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query("COMMIT");
      committed = true;
      await racers;
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
    const events = await db
      .select({ id: schema.domainEvents.id })
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.runId, runId),
          eq(schema.domainEvents.kind, "run.abandoned"),
        ),
      );

    expect(events).toHaveLength(1);
  });
});
