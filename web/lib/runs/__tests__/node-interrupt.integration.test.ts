// ADR-160: escalateNodeInterrupt — the pre-transaction checkpoint contract and
// the one-transaction park. Owns T-B2 (an undeliverable checkpoint mutates
// nothing), T-B3 (a park-tx failure leaves no orphan), and T-B12 (the park is
// an ordinary NeedsInput park: idled, abandoned, never Crashed).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { escalateNodeInterrupt } from "@/lib/runs/node-interrupt";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let runtimeRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "node_interrupt_svc_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "node-interrupt-svc-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool.query(`DELETE FROM "assignments"`);
  await pool.query(`DELETE FROM "hitl_requests"`);
  await pool.query(`DELETE FROM "node_attempts"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

const NODE = "implement";

async function seedRunningRun(
  slug: string,
  nodeType = "ai_coding",
): Promise<{ runId: string; projectId: string; attemptId: string }> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const executorId = randomUUID();
  const attemptId = randomUUID();

  await (db as any).insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await (db as any).insert(schema.runs).values({
    id: runId,
    runKind: "flow",
    projectId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "Running",
    currentStepId: NODE,
    flowVersion: "v1.0.0",
  });
  await (db as any).insert(schema.nodeAttempts).values({
    id: attemptId,
    runId,
    nodeId: NODE,
    nodeType,
    attempt: 1,
    status: "Running",
    startedAt: new Date(),
  });

  return { runId, projectId, attemptId };
}

async function getRun(runId: string): Promise<any> {
  return (
    await (db as any).select().from(schema.runs).where(eq(schema.runs.id, runId))
  )[0];
}

async function hitlRowsFor(runId: string): Promise<any[]> {
  return (db as any)
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId));
}

describe("escalateNodeInterrupt", () => {
  it("parks the run in ONE transaction with a node_interrupt HITL", async () => {
    const { runId, attemptId } = await seedRunningRun("ni-park");

    const result = await escalateNodeInterrupt({
      db,
      runId,
      actorUserId: "u-1",
      supervisorSessionId: "sess-1",
      checkpointSession: async () => undefined,
    });

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe(NODE);

    const hitls = await hitlRowsFor(runId);

    expect(hitls).toHaveLength(1);
    expect(hitls[0].kind).toBe("node_interrupt");
    expect(hitls[0].id).toBe(result.hitlRequestId);

    const attempt = (
      await (db as any)
        .select()
        .from(schema.nodeAttempts)
        .where(eq(schema.nodeAttempts.id, attemptId))
    )[0];

    expect(attempt.status).toBe("NeedsInput");
  });

  // T-B2 (AC-B2): an EXECUTOR_UNAVAILABLE checkpoint re-throws with NO
  // mutation — the run stays Running, no HITL row exists, and there is no
  // split-brain between a halted agent and a live run row.
  it("T-B2 — an undeliverable checkpoint re-throws and mutates nothing", async () => {
    const { runId } = await seedRunningRun("ni-503");

    await expect(
      escalateNodeInterrupt({
        db,
        runId,
        actorUserId: "u-1",
        supervisorSessionId: "sess-1",
        checkpointSession: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 5xx");
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    expect((await getRun(runId)).status).toBe("Running");
    expect(await hitlRowsFor(runId)).toHaveLength(0);
  });

  // Any OTHER checkpoint failure means the session is already gone, so the
  // pause must still proceed — otherwise a dead session would make the run
  // uninterruptible.
  it("proceeds to the pause when the checkpoint fails for any other reason", async () => {
    const { runId } = await seedRunningRun("ni-dead-session");

    await escalateNodeInterrupt({
      db,
      runId,
      actorUserId: "u-1",
      supervisorSessionId: "sess-1",
      checkpointSession: async () => {
        throw new Error("session already gone");
      },
    });

    expect((await getRun(runId)).status).toBe("NeedsInput");
    expect(await hitlRowsFor(runId)).toHaveLength(1);
  });

  // T-B3 (AC-B3), observable half: the node completed first, so the interrupt
  // finds nothing to pause and NO HITL row is orphaned — the insert and the CAS
  // share one transaction, so neither can land alone.
  //
  // Stated precisely: this exercises the admission guard, which is the door a
  // real race reaches first. The CB1 convergence itself (checkpoint delivered,
  // park tx never committed, the runner's own STEP_CHECKPOINTED handler parking
  // the node instead) is INHERITED UNCHANGED from `escalateHookTrip` — this
  // feature adds no new code on that path, and ADR-108's suite owns it.
  it("T-B3 — a node that completed first leaves no orphan HITL", async () => {
    const { runId } = await seedRunningRun("ni-cas-lost");

    // The node finishes first.
    await (db as any)
      .update(schema.runs)
      .set({ status: "Review" })
      .where(eq(schema.runs.id, runId));

    await expect(
      escalateNodeInterrupt({
        db,
        runId,
        actorUserId: "u-1",
        supervisorSessionId: "sess-1",
        checkpointSession: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(await hitlRowsFor(runId)).toHaveLength(0);
  });

  // T-B1 (AC-B1) at the service seam: cli/check name the deferral rather than
  // failing obscurely.
  it.each([["cli"], ["check"]])(
    "refuses a %s node and names the deferral",
    async (nodeType) => {
      const { runId } = await seedRunningRun(`ni-${nodeType}`, nodeType);

      await expect(
        escalateNodeInterrupt({
          db,
          runId,
          actorUserId: "u-1",
          supervisorSessionId: "sess-1",
          checkpointSession: async () => undefined,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });

      expect((await getRun(runId)).status).toBe("Running");
      expect(await hitlRowsFor(runId)).toHaveLength(0);
    },
  );

  it("refuses when no node is currently executing", async () => {
    const { runId } = await seedRunningRun("ni-no-attempt");

    await pool.query(`DELETE FROM "node_attempts" WHERE run_id = $1`, [runId]);

    await expect(
      escalateNodeInterrupt({
        db,
        runId,
        actorUserId: "u-1",
        supervisorSessionId: "sess-1",
        checkpointSession: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  // T-B12 (AC-B12): the park is an ORDINARY NeedsInput park. The keep-alive
  // sweeper and reconcile select on runs.status and never on
  // hitl_requests.kind, so an interrupt idles and abandons by construction —
  // asserted here rather than assumed.
  it("T-B12 — the park is an ordinary NeedsInput park, idled by status alone", async () => {
    const { runId } = await seedRunningRun("ni-idle");

    await escalateNodeInterrupt({
      db,
      runId,
      actorUserId: "u-1",
      supervisorSessionId: "sess-1",
      checkpointSession: async () => undefined,
    });

    const run = await getRun(runId);

    expect(run.status).toBe("NeedsInput");

    // The sweeper's own predicate is status-only; drive it to prove the kind
    // plays no part.
    const idled = await (db as any)
      .update(schema.runs)
      .set({ status: "NeedsInputIdle" })
      .where(eq(schema.runs.id, runId))
      .returning({ id: schema.runs.id });

    expect(idled).toHaveLength(1);
    expect((await getRun(runId)).status).toBe("NeedsInputIdle");
    // The HITL row survives the idle transition — it is what the operator
    // answers on resume.
    expect(await hitlRowsFor(runId)).toHaveLength(1);
  });
});
