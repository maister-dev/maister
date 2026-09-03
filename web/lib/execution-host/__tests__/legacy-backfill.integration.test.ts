// ADR-165 T5.2 (D9, X-EH-18, X-EH-22) — evidence-based backfill of pre-Stage-A
// active runs against a REAL supervisor:
//   Y1 Running + live host session + NULL assignment → epoch 1 legacy_backfill
//      (the host's own assignment id, the adopted handle copied forward, the
//      run_sessions row linked);
//   Y2 Running without a session → left NULL; the reconcile sweep marks Crashed;
//   Y3 NeedsInputIdle → left NULL; the next resume claim mints a normal
//      `resume` generation (no legacy row ever exists);
//   Y5 lazy path: the keep-alive sweeper checkpointing a legacy NeedsInput run
//      mints lazily with WARN legacy-run-assigned-lazily;
//   Y4 no registered host → skipped, logged ONCE, no throw (retry on the sweep).

import type { Db } from "@/lib/execution-host/db";
import type {
  CreateSessionPayload,
  ExecutionHostTransport,
} from "@/lib/execution-host/contracts";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import pino, { type Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import {
  adoptLegacyActiveRuns,
  resetLegacyBackfillStateForTests,
} from "@/lib/execution-host/legacy";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { runReconcileSweep } from "@/lib/reconcile";
import { listWorktrees } from "@/lib/worktree";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { resumeRun } from "@/lib/runs/resume";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const AGENT_FLOW = {
  schemaVersion: 1,
  name: "legacy",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "do thing" },
      transitions: { success: "done" },
    },
  ],
};

function captureLogger(): {
  logger: Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => void lines.push(JSON.parse(s)) },
  );

  return { logger, lines };
}

async function runRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

  return rows[0];
}

async function sessionRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as Array<Record<string, any>>;

  return rows[0];
}

async function assignmentsOf(runId: string) {
  return (await db
    .select()
    .from(schema.executionAssignments)
    .where(eq(schema.executionAssignments.runId, runId))
    .orderBy(asc(schema.executionAssignments.epoch))) as Array<
    Record<string, any>
  >;
}

// A pre-Stage-A run: seeded WITHOUT a placement (NULL assignment).
async function seedLegacyRun(name: string, run: Record<string, unknown>) {
  const repoPath = await initRepo(`${sup.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  return seedGraphRun(testDatabase.db, AGENT_FLOW, {
    repoPath,
    workspace: { worktreePath, parentRepoPath: repoPath },
    run,
  });
}

// A live session on the host that the web tier never placed: the host stamps
// it with the fence of the create (what a transitional-window session carries).
async function createLegacySession(seeded: {
  runId: string;
  slug: string;
  worktreePath: string;
}) {
  const wire = createLocalDirectTransport();
  const health = await wire.health();

  if (health.kind !== "ready" || !health.identity) {
    throw new Error("real supervisor not ready");
  }
  const fence = {
    hostKey: health.identity.hostKey,
    assignmentId: randomUUID(),
    assignmentEpoch: 1,
    runId: seeded.runId,
  };
  const adopted = await wire.adoptWorkspace(
    buildEnvelope({
      commandId: randomUUID(),
      kind: "workspace.adopt",
      ...fence,
      payload: {
        runId: seeded.runId,
        projectSlug: seeded.slug,
        kind: "directory",
        path: seeded.worktreePath,
      },
    }),
  );
  const created = await wire.createSession(
    buildEnvelope({
      commandId: randomUUID(),
      kind: "session.create",
      ...fence,
      payload: {
        executionWorkspaceId: adopted.executionWorkspaceId,
        stepId: "implement",
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
      } as CreateSessionPayload,
    }),
  );

  await db
    .update(schema.runSessions)
    .set({
      hostSessionId: created.sessionId,
      acpSessionId: created.acpSessionId,
    })
    .where(eq(schema.runSessions.runId, seeded.runId));

  return {
    ...created,
    assignmentId: fence.assignmentId,
    executionWorkspaceId: adopted.executionWorkspaceId,
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_legacy_backfill_test",
  });
  db = testDatabase.db as unknown as Db;
  sup = await startRealSupervisor({
    fixture: "mock-acp-lifecycle.mjs",
    fixtureArgs: ["--hang"],
  });
  restoreUrl = useRealSupervisorUrl(sup.url);
  setDefaultTransportForTests(null);
  resetRegistrarStateForTests();
  resetResolverForTests();
  resetLegacyBackfillStateForTests();
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("legacy backfill (real supervisor)", () => {
  it("Y1: a Running run with a live host session and NULL assignment is backfilled at epoch 1 under the host's own fence", async () => {
    const seeded = await seedLegacyRun("y1", { status: "Running" });
    const live = await createLegacySession(seeded);
    const { logger, lines } = captureLogger();

    expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();

    const summary = await adoptLegacyActiveRuns({ db, logger });

    expect(summary).toMatchObject({ minted: 1, skipped: null, errors: [] });
    const assignments = await assignmentsOf(seeded.runId);

    expect(
      assignments.map((a) => [a.epoch, a.state, a.placementReason]),
    ).toEqual([[1, "active", "legacy_backfill"]]);
    expect(assignments[0].id).toBe(live.assignmentId);
    expect(assignments[0].executionWorkspaceId).toBe(live.executionWorkspaceId);
    expect((await runRow(seeded.runId)).executionAssignmentId).toBe(
      assignments[0].id,
    );
    expect((await sessionRow(seeded.runId)).executionAssignmentId).toBe(
      assignments[0].id,
    );
    expect(
      lines.some(
        (l) => l.msg === "legacy-run-backfilled" && l.runId === seeded.runId,
      ),
    ).toBe(true);

    // Idempotent: the run is no longer a candidate.
    const again = await adoptLegacyActiveRuns({ db, logger });

    expect(again.minted).toBe(0);
    expect(await assignmentsOf(seeded.runId)).toHaveLength(1);
  }, 120_000);

  it("Y2: a Running run without a host session is left NULL; the reconcile sweep classifies it (re-drive with a worktree, Crashed without one)", async () => {
    const redrivable = await seedLegacyRun("y2a", { status: "Running" });
    const gone = await seedLegacyRun("y2b", { status: "Running" });
    const summary = await adoptLegacyActiveRuns({ db });

    expect(summary.leftNull).toBeGreaterThanOrEqual(2);
    for (const seeded of [redrivable, gone]) {
      expect(await assignmentsOf(seeded.runId)).toEqual([]);
      expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();
    }

    // Reconcile owns the classification: a run whose worktree survived is
    // re-driven from its current node; a run whose worktree is gone is Crashed
    // — neither is placed by the backfill.
    const reconcile = await runReconcileSweep({
      db,
      executionHosts: createExecutionHosts({ db }),
      listWorktrees: async (repoPath) =>
        repoPath === gone.repoPath ? [] : listWorktrees(repoPath),
    });

    expect(reconcile.crashed).toBeGreaterThanOrEqual(1);
    expect((await runRow(gone.runId)).status).toBe("Crashed");
    expect(await assignmentsOf(gone.runId)).toEqual([]);
    expect((await runRow(redrivable.runId)).status).not.toBe("Running");
    expect(
      reconcile.redispatched + reconcile.reattached,
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("Y3: a NeedsInputIdle run is not a candidate; its next resume claim mints a normal `resume` generation", async () => {
    const seeded = await seedLegacyRun("y3", {
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
    });

    await db
      .update(schema.runSessions)
      .set({ acpSessionId: "acp-y3", hostSessionId: "sess-y3" })
      .where(eq(schema.runSessions.runId, seeded.runId));

    const summary = await adoptLegacyActiveRuns({ db });

    expect(await assignmentsOf(seeded.runId)).toEqual([]);
    expect(summary.errors).toEqual([]);

    // The resume path's claim mints epoch 1 `resume` — placement, not backfill.
    // A retryable spawn failure rolls the claim back so no adapter is left
    // behind; the generation it minted is what this test is about.
    const wire = createLocalDirectTransport();
    const failing = createExecutionHosts({
      db,
      transport: {
        ...wire,
        createSession: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503", {
            details: { httpStatus: 503 },
          });
        },
      },
    });
    const r = await resumeRun(seeded.runId, { db, executionHosts: failing });

    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(
      (await assignmentsOf(seeded.runId)).map((a) => [
        a.epoch,
        a.state,
        a.placementReason,
        a.releasedReason,
      ]),
    ).toEqual([[1, "released", "resume", "resume_rollback"]]);
  }, 120_000);

  it("Y5: the keep-alive sweeper checkpointing a legacy NeedsInput run mints lazily with WARN legacy-run-assigned-lazily", async () => {
    const seeded = await seedLegacyRun("y5", {
      status: "NeedsInput",
      keepaliveUntil: new Date(Date.now() - 1_000),
    });

    await createLegacySession(seeded);
    const { logger, lines } = captureLogger();
    const hosts = createExecutionHosts({ db, logger });

    expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();

    await runSweepTick({ db, executionHosts: hosts });

    expect(
      lines.some(
        (l) =>
          l.msg === "legacy-run-assigned-lazily" &&
          l.runId === seeded.runId &&
          l.reason === "legacy_backfill",
      ),
    ).toBe(true);
    const assignments = await assignmentsOf(seeded.runId);

    expect(
      assignments.map((a) => [a.epoch, a.placementReason, a.releasedReason]),
    ).toEqual([[1, "legacy_backfill", "checkpointed"]]);
    expect((await runRow(seeded.runId)).status).toBe("NeedsInputIdle");
  }, 120_000);

  it("Y4: with no registered host the backfill skips, logs once, and never throws", async () => {
    const seeded = await seedLegacyRun("y4", { status: "Running" });
    const wire = createLocalDirectTransport();
    const down: ExecutionHostTransport = {
      ...wire,
      health: async () => ({
        kind: "unavailable",
        reason: "unreachable",
        message: "connection refused",
      }),
    };
    const { logger, lines } = captureLogger();

    resetResolverForTests();
    resetLegacyBackfillStateForTests();
    const first = await adoptLegacyActiveRuns({ db, transport: down, logger });
    const second = await adoptLegacyActiveRuns({
      db,
      transport: down,
      logger,
    });

    expect(first.skipped).toBe("no_host");
    expect(second.skipped).toBe("no_host");
    expect(
      lines.filter((l) => l.msg === "legacy-backfill-skipped-no-host"),
    ).toHaveLength(1);
    expect(await assignmentsOf(seeded.runId)).toEqual([]);

    // The host coming back clears the once-per-outage latch.
    resetResolverForTests();
    resetRegistrarStateForTests();
    const back = await adoptLegacyActiveRuns({ db, logger });

    expect(back.skipped).toBeNull();
  }, 120_000);
});
