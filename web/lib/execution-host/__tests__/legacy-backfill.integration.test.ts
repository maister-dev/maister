// ADR-166 T5.2 (D9, X-EH-18, X-EH-22) — pre-Stage-A active runs against a
// REAL supervisor. There is nothing to place them on (every host session since
// the strict flip belongs to a minted assignment), so the pass only REPORTS:
//   Y1 Running + NULL assignment → reported ONCE (`legacy-runs-unplaced`) and
//      never minted, even when the host lists a live session for the run;
//   Y2 Running without a session → left NULL; the reconcile sweep classifies;
//   Y3 NeedsInputIdle → not a candidate; the next resume claim mints a normal
//      `resume` generation (no legacy row ever exists);
//   Y5 lazy path: the keep-alive sweeper checkpointing a legacy NeedsInput run
//      mints lazily with WARN legacy-run-assigned-lazily;
//   Y4 reporting never contacts the host and never throws.

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
  reportLegacyActiveRuns,
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

function unplacedReports(lines: Array<Record<string, unknown>>, runId: string) {
  return lines.filter(
    (l) =>
      l.msg === "legacy-runs-unplaced" &&
      Array.isArray(l.candidates) &&
      (l.candidates as Array<{ runId: string }>).some((c) => c.runId === runId),
  );
}

async function runRow(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

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
  setDefaultTransportForTests(null);
  restoreUrl();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("legacy runs (real supervisor)", () => {
  it("Y1: a Running run with NULL assignment is reported once and never minted, even when the host lists a live session for it", async () => {
    const seeded = await seedLegacyRun("y1", { status: "Running" });
    const live = await createLegacySession(seeded);
    const { logger, lines } = captureLogger();

    expect(
      (await createExecutionHosts({ db }).local().listSessions()).some(
        (s) => s.sessionId === live.sessionId && s.status === "live",
      ),
    ).toBe(true);
    expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();

    const first = await reportLegacyActiveRuns({ db, logger });

    expect(first.candidates).toBeGreaterThanOrEqual(1);
    expect(first.runIds).toContain(seeded.runId);
    expect(await assignmentsOf(seeded.runId)).toEqual([]);
    expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();
    expect(unplacedReports(lines, seeded.runId)).toHaveLength(1);
    expect(
      (
        unplacedReports(lines, seeded.runId)[0].candidates as Array<{
          runId: string;
          status: string;
        }>
      ).find((c) => c.runId === seeded.runId)?.status,
    ).toBe("Running");

    // Still a candidate, but reported only once per run.
    const second = await reportLegacyActiveRuns({ db, logger });

    expect(second.runIds).toContain(seeded.runId);
    expect(unplacedReports(lines, seeded.runId)).toHaveLength(1);
    expect(await assignmentsOf(seeded.runId)).toEqual([]);
  }, 120_000);

  it("Y2: a Running run without a host session is left NULL; the reconcile sweep classifies it (re-drive with a worktree, Crashed without one)", async () => {
    const redrivable = await seedLegacyRun("y2a", { status: "Running" });
    const gone = await seedLegacyRun("y2b", { status: "Running" });
    const summary = await reportLegacyActiveRuns({ db });

    expect(summary.runIds).toEqual(
      expect.arrayContaining([redrivable.runId, gone.runId]),
    );
    for (const seeded of [redrivable, gone]) {
      expect(await assignmentsOf(seeded.runId)).toEqual([]);
      expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();
    }

    // Reconcile owns the classification: a run whose worktree survived is
    // re-driven from its current node; a run whose worktree is gone is Crashed
    // — neither is placed by the report.
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

    const summary = await reportLegacyActiveRuns({ db });

    expect(summary.runIds).not.toContain(seeded.runId);
    expect(await assignmentsOf(seeded.runId)).toEqual([]);

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

  it("Y4: reporting never contacts the host and never throws", async () => {
    const seeded = await seedLegacyRun("y4", { status: "Running" });
    const contacted: string[] = [];
    // Every implicit resolution would land here: any method call is a failure.
    const unreachable = new Proxy({} as ExecutionHostTransport, {
      get: (_target, prop) => () => {
        contacted.push(String(prop));
        throw new Error(`host contacted through ${String(prop)}`);
      },
    });
    const { logger, lines } = captureLogger();

    setDefaultTransportForTests(unreachable);
    resetResolverForTests();
    resetLegacyBackfillStateForTests();
    try {
      const first = await reportLegacyActiveRuns({ db, logger });
      const second = await reportLegacyActiveRuns({ db, logger });

      expect(first.runIds).toContain(seeded.runId);
      expect(second.runIds).toContain(seeded.runId);
    } finally {
      setDefaultTransportForTests(null);
    }

    expect(contacted).toEqual([]);
    expect(unplacedReports(lines, seeded.runId)).toHaveLength(1);
    expect(await assignmentsOf(seeded.runId)).toEqual([]);
    expect((await runRow(seeded.runId)).executionAssignmentId).toBeNull();
  }, 120_000);
});
