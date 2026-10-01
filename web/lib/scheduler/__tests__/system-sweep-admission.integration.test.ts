import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { promoteNextPending } from "@/lib/scheduler";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { recordHostPressureRefusal } from "@/lib/execution-host/host-pressure";
import {
  admitScratchPrompt,
  scratchPromptOwners,
} from "@/lib/scratch-runs/prompt-owner";
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
import { seedWorkspace } from "@/test-support/execution-host-seed";
import {
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import { submitOwnerMessage } from "@/lib/librarian/admission";
import { promoteNextLibrarianTurn } from "@/lib/librarian/pool";
import { resetLibrarianConfigForTests } from "@/lib/librarian/config";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let hostId: string;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
const userId = "a1-sweep-user";
const dispatched = vi.hoisted(() => ({
  flow: vi.fn(async (_id: string) => {}),
  resume: vi.fn(async (_id: string) => {}),
  agent: vi.fn(async (_id: string) => {}),
  scratch: vi.fn(async (_input: { runId: string }) => {}),
  librarian: vi.fn(async (_id: string) => {}),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/flows/runner", () => ({ runFlow: dispatched.flow }));
vi.mock("@/lib/runs/recover", () => ({ driveResume: dispatched.resume }));
vi.mock("@/lib/agents/launch", async (original) => ({
  ...(await original<typeof import("@/lib/agents/launch")>()),
  startAgentSession: dispatched.agent,
}));
vi.mock("@/lib/scratch-runs/idle-resume", async (original) => ({
  ...(await original<typeof import("@/lib/scratch-runs/idle-resume")>()),
  driveScratchIdleResume: dispatched.scratch,
}));
vi.mock("@/lib/librarian/runtime", () => ({
  startLibrarianTurn: dispatched.librarian,
}));

// Keep the production tick, sweep, pressure record and every admission gate.
// Unrelated GC/TTL/notification arms are inert so this test cannot delete a
// fixture or provide a second admission edge while the owning control waits.
vi.mock("@/lib/runs/keepalive-sweeper", () => ({
  runSweepTick: async () => null,
}));
vi.mock("@/lib/reconcile", () => ({ runReconcileSweep: async () => null }));
vi.mock("@/lib/runs/sync-recovery", () => ({
  runSyncRecoverySweep: async () => null,
}));
vi.mock("@/lib/librarian/turn-recovery", () => ({
  runLibrarianTurnSweep: async () => null,
}));
vi.mock("@/lib/librarian/retention", () => ({
  runLibrarianRetention: async () => null,
}));
vi.mock("@/lib/runs/cost-reconcile-sweep", () => ({
  reconcileTerminalCostRollups: async () => null,
}));
vi.mock("@/lib/execution-host", async (original) => ({
  ...(await original<typeof import("@/lib/execution-host")>()),
  executionHosts: { local: () => hosts.local() },
  ensureLocalExecutionDataPlane: async () => ({
    status: "registered",
    host: { id: hostId },
  }),
  executionCommandReconcilePass: async () => ({
    commands: { errors: [], impasse: null },
  }),
}));
vi.mock("@/lib/execution-host/events/stream-health", () => ({
  runEventStreamHealthSweep: async () => ({ errors: [] }),
}));
vi.mock("@/lib/gc/workspace-gc", () => ({
  runWorkspaceGcSweep: async () => null,
}));
vi.mock("@/lib/gc/workspace-reconciler", () => ({
  runWorkspaceReconciliationSweep: async () => null,
}));
vi.mock("@/lib/gc/revision-gc", () => ({
  runRevisionGcSweep: async () => null,
}));
vi.mock("@/lib/capabilities/cleanup", () => ({
  runCapabilitiesCleanupSweep: async () => null,
}));
vi.mock("@/lib/gc/ephemeral-agent-gc", () => ({
  runEphemeralAgentGcSweep: async () => null,
}));
vi.mock("@/lib/gc/context-mount-gc", () => ({
  runContextMountGcSweep: async () => null,
}));
vi.mock("@/lib/gc/agent-materialization-gc", () => ({
  runAgentMaterializationCleanupSweep: async () => null,
}));
vi.mock("@/lib/evaluations/evidence/gc", () => ({
  sweepEvaluationEvidence: async () => null,
}));
vi.mock("@/lib/gc/plain-agent-directory-gc", () => ({
  runPlainAgentDirectoryGcSweep: async () => null,
}));
vi.mock("@/lib/brain/decay", () => ({
  runBrainDecaySweep: async () => ({ errors: [] }),
}));
vi.mock("@/lib/brain/reindex", () => ({
  runBrainReindexSweep: async () => ({ errors: [] }),
}));
vi.mock("@/lib/notifications/digest-trigger", () => ({
  runDigestTrigger: async () => ({ errors: [] }),
  runDecisionsDeltaBackstop: async () => ({ errors: [] }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "r9_a1_sweep" });
  db = database.db as unknown as Db;
  process.env.DB_URL = database.container.getConnectionUri();
  await db.insert(schema.users).values({ id: userId, email: "a1@test" });
  ({ hostId, fake, hosts } = await fakeExecutionHosts(db));
  await seedLibrarianPlatform(database.db);
}, 180_000);

afterAll(async () => {
  delete process.env.DB_URL;
  await database?.stop();
});

afterEach(async () => {
  for (const dispatch of Object.values(dispatched)) dispatch.mockClear();
  delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  delete process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS;
  resetLibrarianConfigForTests();
  // Canonical evidence forbids ordinary cascade deletion. Retain the history
  // in this disposable database and remove every run from admission instead.
  await db.update(schema.runs).set({ status: "Abandoned" });
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
  await db.delete(schema.executionHostPressure);
});

async function seedCandidate(
  kind: "flow" | "scratch" | "agent",
  status: "Pending" | "NeedsInputIdle" | "Running" = "Pending",
): Promise<string> {
  const projectId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `a1-${runId}`,
    name: "A1",
    repoPath: `/tmp/a1-${runId}`,
    maisterYamlPath: "/tmp/maister.yaml",
    taskKey: `A${runId.slice(0, 7)}`.toUpperCase(),
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    createdByUserId: userId,
    runKind: kind,
    status,
    flowVersion: "test",
    startedAt: new Date(Date.now() - 100_000),
    resumeRequestedAt:
      status === "NeedsInputIdle" ? new Date(Date.now() - 10_000) : null,
  });
  if (kind === "scratch")
    await db.insert(schema.scratchRuns).values({
      runId,
      projectId,
      createdByUserId: userId,
      initialPrompt: "A1",
      baseBranch: "main",
      baseCommit: "abc",
      dialogStatus: status === "NeedsInputIdle" ? "NeedsInput" : "Running",
    });
  if (kind === "agent" && status === "NeedsInputIdle") {
    await fakeExecutionHosts(db, { fake, runId });
    await db.transaction((tx) =>
      releaseAssignmentForRun(tx, runId, "checkpointed"),
    );
  }

  return runId;
}

async function statusOf(runId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row?.status;
}

async function tick(): Promise<void> {
  const result = await runSchedulerTick({ jobKind: "system_sweep" });

  expect(result).toMatchObject({
    attemptedCount: 1,
    succeededCount: 1,
    failedCount: 0,
  });
}

async function queueLibrarianTurn(): Promise<{
  occupiedId: string;
  turnId: string;
  runId: string;
}> {
  process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS = "1";
  resetLibrarianConfigForTests();
  const occupiedId = randomUUID();

  await db.insert(schema.runs).values({
    id: occupiedId,
    runKind: "librarian",
    createdByUserId: userId,
    persistent: true,
    agentWorkspace: "none",
    status: "Running",
    flowVersion: "librarian",
  });
  const ownerId = await seedActiveUser(database.db);
  const sent = await submitOwnerMessage(
    ownerId,
    { clientMessageId: randomUUID(), body: "queued", subject: null },
    { db, start: dispatched.librarian },
  );
  const [conversation] = await db
    .select()
    .from(schema.librarianConversations)
    .where(eq(schema.librarianConversations.userId, ownerId));

  expect(sent.turn?.status).toBe("admitted");
  expect(dispatched.librarian).not.toHaveBeenCalled();

  return { occupiedId, turnId: sent.turn!.id, runId: conversation!.runId! };
}

describe("A1 production tick admission backstop", () => {
  it.each(["Pending", "NeedsInputIdle"] as const)(
    "retries a flow %s SKIP LOCKED miss within one sweep without another freed slot",
    async (status) => {
      const runId = await seedCandidate("flow", status);
      const lock = await database.pool.connect();

      try {
        await lock.query("BEGIN");
        await lock.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [runId]);
        expect(await promoteNextPending({ db })).toEqual({
          promotedRunId: null,
        });
        await lock.query("COMMIT");
        await tick();
        expect(await statusOf(runId)).toBe(
          status === "Pending" ? "Running" : "NeedsInput",
        );
        expect(
          (status === "Pending" ? dispatched.flow : dispatched.resume).mock
            .calls,
        ).toEqual([[runId]]);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
    },
  );

  it("retries a scratch answered-idle row held by the actual stale prompt-owner application transaction", async () => {
    const runId = await seedCandidate("scratch", "Running");
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    await seedWorkspace(database.db, {
      runId,
      projectId: run!.projectId!,
      worktreePath: `/tmp/a1-${runId}`,
      parentRepoPath: "/tmp",
    });
    const { hosts } = await fakeExecutionHosts(db, { fake, runId });
    const execution = await hosts.executionFor(runId);
    const session = await execution.client.createSession({
      stepId: "scratch",
      executor: { agent: "claude", model: "mock" },
    });

    await waitForPromptIncarnation(db, execution.client, session.hostSessionId);
    const prompt = await execution.client.prompt(
      session.hostSessionId,
      { stepId: "scratch", prompt: "old turn" },
      {
        admitOwner: (tx) =>
          admitScratchPrompt(tx, execution.client, session.hostSessionId, {
            variant: "initial",
          }),
      },
    );

    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(schema.executionCommands)
              .where(eq(schema.executionCommands.id, prompt.commandId))
          )[0]?.state,
      )
      .toBe("succeeded");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.runs)
        .set({
          status: "NeedsInputIdle",
          resumeRequestedAt: new Date(),
          checkpointAt: new Date(),
        })
        .where(eq(schema.runs.id, runId));
      await tx
        .update(schema.scratchRuns)
        .set({ dialogStatus: "NeedsInput" })
        .where(eq(schema.scratchRuns.runId, runId));
      await releaseAssignmentForRun(tx, runId, "checkpointed");
    });
    await db.insert(schema.hitlRequests).values({
      id: randomUUID(),
      runId,
      stepId: "scratch",
      kind: "permission",
      prompt: "Approve",
      schema: {
        requestId: "parked",
        supervisorSessionId: session.hostSessionId,
      },
      response: { optionId: "allow" },
    });
    const barrier = await database.pool.connect();
    let applying: Promise<unknown> | undefined;

    try {
      await barrier.query("SELECT pg_advisory_lock(987321)");
      const pid = (
        await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;

      await database.pool.query(
        `CREATE FUNCTION a1_hold_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${prompt.commandId}' AND NEW.application_state = 'superseded' THEN PERFORM pg_advisory_xact_lock(987321); END IF; RETURN NEW; END $$; CREATE TRIGGER a1_hold_application BEFORE UPDATE ON execution_commands FOR EACH ROW EXECUTE FUNCTION a1_hold_application()`,
      );
      applying = applyPromptOwner({
        db: db as Db,
        owners: scratchPromptOwners,
        commandId: prompt.commandId,
        signal: new AbortController().signal,
      });
      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0]!.count,
        )
        .toBe(1);
      expect(await promoteNextPending({ db })).toEqual({ promotedRunId: null });
      expect(await statusOf(runId)).toBe("NeedsInputIdle");
      await barrier.query("SELECT pg_advisory_unlock(987321)");
      expect(await applying).toBe("superseded");
      await tick();
      expect(await statusOf(runId)).toBe("Running");
      expect(dispatched.scratch).toHaveBeenCalledOnce();
      expect(dispatched.scratch.mock.calls[0]?.[0]).toMatchObject({ runId });
      const commands = await db
        .select()
        .from(schema.executionCommands)
        .where(eq(schema.executionCommands.runId, runId));

      expect(
        commands.filter((command) => command.kind === "session.prompt"),
      ).toHaveLength(1);
    } finally {
      await barrier.query("SELECT pg_advisory_unlock(987321)");
      barrier.release();
      await applying;
      await database.pool.query(
        "DROP TRIGGER IF EXISTS a1_hold_application ON execution_commands; DROP FUNCTION IF EXISTS a1_hold_application()",
      );
    }
  }, 60_000);

  it("drains C1 and C3 in the agent pool through its own dispatcher", async () => {
    const pending = await seedCandidate("agent");
    const idle = await seedCandidate("agent", "NeedsInputIdle");

    await tick();
    expect(dispatched.agent.mock.calls.map(([id]) => id).sort()).toEqual(
      [pending, idle].sort(),
    );
    expect(await statusOf(pending)).toBe("Running");
    expect(await statusOf(idle)).toBe("Running");
  });

  it("races the system sweep with two existing slot/owner retry gates without a second launch", async () => {
    const runId = await seedCandidate("flow");

    await Promise.all([
      tick(),
      promoteNextPending({ db }),
      promoteNextPending({ db }),
    ]);
    expect(dispatched.flow.mock.calls).toEqual([[runId]]);
    expect(await statusOf(runId)).toBe("Running");
  });

  it.each(["Pending", "NeedsInputIdle"] as const)(
    "reaches a later eligible %s candidate beyond permanently parent-cap-blocked rows",
    async (status) => {
      process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
      const parent = await seedCandidate("flow");

      await db
        .update(schema.runs)
        .set({
          status: "WaitingOnChildren",
          delegationBounds: {
            nodeId: "coordinator",
            nodeAttemptId: randomUUID(),
            engineMin: "3.7.0",
            source: "node",
            maxDepth: 3,
            maxFanout: 10,
            maxActiveChildren: 1,
            budget: null,
            declared: { max_active_children: 1 },
            instance: { maxDepth: 3, maxFanout: 10, flowPool: 1, agentPool: 2 },
          },
        })
        .where(eq(schema.runs.id, parent));
      const liveChild = await seedCandidate("agent", "Running");

      await db
        .update(schema.runs)
        .set({ parentRunId: parent })
        .where(eq(schema.runs.id, liveChild));
      const blocked = await Promise.all([
        seedCandidate("flow", status),
        seedCandidate("flow", status),
        seedCandidate("flow", status),
      ]);

      for (const runId of blocked)
        await db
          .update(schema.runs)
          .set({
            parentRunId: parent,
            startedAt: new Date(0),
            resumeRequestedAt: status === "NeedsInputIdle" ? new Date(0) : null,
          })
          .where(eq(schema.runs.id, runId));
      const eligible = await seedCandidate("flow", status);

      await database.pool.query(
        `INSERT INTO runs(id, project_id, created_by_user_id, run_kind, status, flow_version)
         SELECT 'a1-history-' || $1 || '-' || n, project_id, created_by_user_id, 'flow', 'Abandoned', 'test'
         FROM runs CROSS JOIN generate_series(1, 24000) n WHERE id = $1`,
        [eligible],
      );
      await database.pool.query("ANALYZE runs");
      const queries: Array<{ query: string; params: unknown[] }> = [];
      const originalDb = db;

      db = drizzle(database.pool, {
        schema,
        logger: {
          logQuery(query: string, params: unknown[]): void {
            if (
              query.includes('for update of "runs" skip locked') &&
              params.includes("scratch")
            )
              queries.push({ query, params });
          },
        },
      });
      try {
        await tick();
      } finally {
        db = originalDb;
      }
      await db
        .update(schema.runs)
        .set({ status })
        .where(eq(schema.runs.id, eligible));
      for (const query of queries) {
        const result = await database.pool.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`,
          query.params,
        );

        // eslint-disable-next-line no-console
        console.info(
          JSON.stringify({
            case: status,
            cardinality: 24000,
            query: query.query,
            plan: result.rows[0]?.["QUERY PLAN"],
          }),
        );
      }
      expect(queries).toHaveLength(2);
      await db
        .update(schema.runs)
        .set({ status: "Running" })
        .where(eq(schema.runs.id, eligible));
      expect(
        (status === "Pending" ? dispatched.flow : dispatched.resume).mock.calls,
      ).toEqual([[eligible]]);
      for (const runId of blocked) expect(await statusOf(runId)).toBe(status);
    },
  );

  it("reaches a later candidate beyond a shared tree held by a writer in the other pool", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
    const root = await seedCandidate("flow");

    await db
      .update(schema.runs)
      .set({ status: "WaitingOnChildren" })
      .where(eq(schema.runs.id, root));
    const writer = await seedCandidate("agent", "Running");
    const blocked = await seedCandidate("flow");

    for (const runId of [writer, blocked])
      await db
        .update(schema.runs)
        .set({
          rootRunId: root,
          workspaceMode: "shared",
          startedAt: new Date(0),
        })
        .where(eq(schema.runs.id, runId));
    const eligible = await seedCandidate("flow");

    await tick();
    expect(dispatched.flow.mock.calls).toEqual([[eligible]]);
    expect(await statusOf(blocked)).toBe("Pending");
  });

  it("delegates the Librarian pool to its existing claim while racing a turn admission retry", async () => {
    process.env.MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS = "1";
    resetLibrarianConfigForTests();
    const ownerId = await seedActiveUser(database.db);
    const occupied = await seedCandidate("flow");

    await db
      .update(schema.runs)
      .set({
        runKind: "librarian",
        status: "Running",
        projectId: null,
        persistent: true,
        agentWorkspace: "none",
      })
      .where(eq(schema.runs.id, occupied));
    const sent = await submitOwnerMessage(
      ownerId,
      { clientMessageId: randomUUID(), body: "queued", subject: null },
      { db, start: dispatched.librarian },
    );

    expect(sent.turn?.status).toBe("admitted");
    expect(dispatched.librarian).not.toHaveBeenCalled();
    await db
      .update(schema.runs)
      .set({ status: "Abandoned" })
      .where(eq(schema.runs.id, occupied));
    await Promise.all([
      tick(),
      promoteNextLibrarianTurn({ db, start: dispatched.librarian }),
    ]);
    expect(dispatched.librarian.mock.calls).toEqual([[sent.turn!.id]]);
  });

  it("admits a queued Librarian turn through the routed system sweep alone", async () => {
    const queued = await queueLibrarianTurn();

    await db
      .update(schema.runs)
      .set({ status: "Abandoned" })
      .where(eq(schema.runs.id, queued.occupiedId));
    await tick();
    expect(dispatched.librarian.mock.calls).toEqual([[queued.turnId]]);
    expect(await statusOf(queued.runId)).toBe("Running");
  });

  it.each(["flow", "agent", "librarian"] as const)(
    "keeps the %s pool's queue behind its live capacity",
    async (pool) => {
      let runId: string;

      if (pool === "librarian") {
        runId = (await queueLibrarianTurn()).runId;
      } else {
        process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
        process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
        await seedCandidate(pool, "Running");
        runId = await seedCandidate(pool);
      }
      await tick();
      expect(await statusOf(runId)).toBe("Pending");
      for (const dispatch of Object.values(dispatched))
        expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["flow", "agent", "librarian"] as const)(
    "leaves %s queued while host pressure fences admission",
    async (pool) => {
      let runId: string;

      if (pool === "librarian") {
        const ownerId = await seedActiveUser(database.db);

        await recordHostPressureRefusal(db, hostId);
        const sent = await submitOwnerMessage(
          ownerId,
          { clientMessageId: randomUUID(), body: "pressure", subject: null },
          { db, start: dispatched.librarian },
        );
        const [conversation] = await db
          .select()
          .from(schema.librarianConversations)
          .where(eq(schema.librarianConversations.userId, ownerId));

        expect(sent.turn?.status).toBe("admitted");
        runId = conversation!.runId!;
      } else {
        runId = await seedCandidate(pool);
        await recordHostPressureRefusal(db, hostId);
      }
      await tick();
      expect(await statusOf(runId)).toBe("Pending");
      expect(
        Object.values(dispatched)
          .map((dispatch) => dispatch.mock.calls.length)
          .reduce((total, count) => total + count, 0),
      ).toBe(0);
    },
  );
});
