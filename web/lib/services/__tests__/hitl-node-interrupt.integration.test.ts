// ADR-161: respondToHitl for the `node_interrupt` kind — a four-way operator
// fork over a paused agent node. Mirrors hitl-hook-trip.integration.test.ts
// (testcontainer DB; runFlow + authz mocked).
//
// Owns test ids: T-B4 (human-actor-only at the chokepoint), T-B6 (restart_node
// closes Reworked/operator_interrupt and captures the correction), T-B8
// (restart_from stales downstream), T-B9 (resume keeps the same attempt), and
// the safety-cap + forward-skip refusals.

import type { ExecutionHosts } from "@/lib/execution-host";

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
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let hosts: ExecutionHosts;
let runtimeRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn(async () => {}) }));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));
// The destructive half, stubbed so a test can assert WHETHER it ran. The real
// implementation is `reset --hard` + `git clean -fd`.
const applyWorkspacePolicy = vi.fn(async () => {});

vi.mock("@/lib/flows/graph/workspace-checkpoint", () => ({
  applyWorkspacePolicy: (...args: unknown[]) =>
    applyWorkspacePolicy(...(args as [])),
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "hitl_node_interrupt_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-164: a restart mints a `node_interrupt` placement on the local host.
  ({ hosts } = await fakeExecutionHosts(db));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-node-interrupt-int-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  delete process.env.MAISTER_MAX_OPERATOR_RESTARTS;
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  delete process.env.MAISTER_MAX_OPERATOR_RESTARTS;
  await rm(runtimeRoot, { recursive: true, force: true });
  await pool.query(`DELETE FROM "gate_results"`);
  await pool.query(`DELETE FROM "node_attempts"`);
  await pool.query(`DELETE FROM "assignments"`);
  await pool.query(`DELETE FROM "hitl_requests"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

const INTERRUPTED = "implement";
const EARLIER = "plan";

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await (db as any).insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

// A run parked by an interrupt: `plan` ran and finished, `implement` is the
// parked attempt the operator interrupted.
async function seedParkedRun(
  projectId: string,
  opts: { priorOperatorRestarts?: number } = {},
): Promise<{ runId: string; hitlRequestId: string; parkedAttemptId: string }> {
  const runId = randomUUID();
  const executorId = randomUUID();

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
    status: "NeedsInput",
    currentStepId: INTERRUPTED,
    flowVersion: "v1.0.0",
  });

  await (db as any).insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: EARLIER,
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(Date.now() - 55_000),
  });

  for (let i = 0; i < (opts.priorOperatorRestarts ?? 0); i += 1) {
    await (db as any).insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: INTERRUPTED,
      nodeType: "ai_coding",
      attempt: i + 1,
      status: "Reworked",
      decision: "operator_interrupt",
      startedAt: new Date(Date.now() - 50_000 + i * 1000),
      endedAt: new Date(Date.now() - 49_000 + i * 1000),
    });
  }

  const parkedAttemptId = randomUUID();

  await (db as any).insert(schema.nodeAttempts).values({
    id: parkedAttemptId,
    runId,
    nodeId: INTERRUPTED,
    nodeType: "ai_coding",
    attempt: (opts.priorOperatorRestarts ?? 0) + 1,
    status: "NeedsInput",
    startedAt: new Date(Date.now() - 10_000),
  });

  const hitlRequestId = randomUUID();

  await (db as any).insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: INTERRUPTED,
    kind: "node_interrupt",
    prompt: "You interrupted implement mid-turn.",
    schema: {
      kind: "node_interrupt",
      nodeId: INTERRUPTED,
      decisions: ["resume", "restart_node", "restart_from", "stop"],
    },
    response: null,
    respondedAt: null,
  });

  return { runId, hitlRequestId, parkedAttemptId };
}

async function getAttempt(id: string): Promise<any> {
  return (
    await (db as any)
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.id, id))
  )[0];
}

async function getRun(runId: string): Promise<any> {
  return (
    await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
  )[0];
}

async function getHitl(id: string): Promise<any> {
  return (
    await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, id))
  )[0];
}

const userActor: HitlActor = {
  kind: "user",
  userId: "u-1",
  label: "Test User",
};

describe("respondToHitl node_interrupt integration", () => {
  // T-B4 (AC-B4): human-actor-only, enforced at the chokepoint BEFORE any
  // mutation — a machine token must never answer its own interruption.
  it("T-B4 — refuses a machine/agent token before any mutation", async () => {
    const projectId = await seedProject("ni-token");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "restart_node" } },
        { kind: "token", projectId, tokenId: "t-1" } as unknown as HitlActor,
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Nothing moved.
    expect((await getAttempt(parkedAttemptId)).status).toBe("NeedsInput");
    expect((await getHitl(hitlRequestId)).respondedAt).toBeNull();
  });

  // T-B6 (AC-B6): restart_node closes the parked attempt Reworked with
  // decision='operator_interrupt' and captures the correction as the response,
  // which is what the runner reads back at prompt-build time.
  it("T-B6 — restart_node closes the attempt Reworked/operator_interrupt and stores the correction", async () => {
    const projectId = await seedProject("ni-restart");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          optionId: "restart_node",
          workspacePolicy: "keep",
          correction: "You edited the wrong module — start from src/api.",
        },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);

    const attempt = await getAttempt(parkedAttemptId);

    // `Reworked` (not NeedsInput) is what makes runGraph append a FRESH attempt.
    expect(attempt.status).toBe("Reworked");
    expect(attempt.decision).toBe("operator_interrupt");
    expect(attempt.workspacePolicy).toBe("keep");

    const hitl = await getHitl(hitlRequestId);

    expect(hitl.respondedAt).not.toBeNull();
    expect(hitl.response.correction).toContain("wrong module");
    expect(hitl.response.targetNodeId).toBe(INTERRUPTED);

    // The cursor stays on the interrupted node for a same-node restart.
    expect((await getRun(runId)).currentStepId).toBe(INTERRUPTED);
  });

  // T-B8 (AC-B8): restart_from an earlier node parks the cursor there.
  it("T-B8 — restart_from parks the cursor at the earlier node", async () => {
    const projectId = await seedProject("ni-restart-from");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          optionId: "restart_from",
          targetNodeId: EARLIER,
          workspacePolicy: "keep",
        },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    expect((await getRun(runId)).currentStepId).toBe(EARLIER);
    expect((await getAttempt(parkedAttemptId)).decision).toBe(
      "operator_interrupt",
    );
  });

  // Forward skips are out of scope: a node that never ran in THIS run has no
  // prior attempt and must be refused.
  it("refuses restart_from a node with no prior attempt in this run", async () => {
    const projectId = await seedProject("ni-forward-skip");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { optionId: "restart_from", targetNodeId: "never-ran" },
        },
        userActor,
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect((await getAttempt(parkedAttemptId)).status).toBe("NeedsInput");
    expect((await getHitl(hitlRequestId)).respondedAt).toBeNull();
  });

  // T-B9 (AC-B9): resume leaves the attempt alone — the agent continues the
  // SAME attempt via session/resume, so context is preserved.
  it("T-B9 — resume leaves the parked attempt untouched", async () => {
    const projectId = await seedProject("ni-resume");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);

    const attempt = await getAttempt(parkedAttemptId);

    expect(attempt.status).toBe("NeedsInput");
    expect(attempt.decision).toBeNull();
    expect((await getHitl(hitlRequestId)).respondedAt).not.toBeNull();
  });

  // CB3: two operators answering the same HITL — the already-delivered branch
  // re-drives the resume rather than double-applying.
  it("is idempotent when the same HITL is answered twice", async () => {
    const projectId = await seedProject("ni-twice");
    const { runId, hitlRequestId } = await seedParkedRun(projectId);

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );
    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect((await second.json()).idempotent).toBe(true);
  });

  // The safety cap bounds operator restarts per run; resume stays available.
  it("refuses a restart at the MAISTER_MAX_OPERATOR_RESTARTS cap", async () => {
    process.env.MAISTER_MAX_OPERATOR_RESTARTS = "2";
    const projectId = await seedProject("ni-cap");
    const { runId, hitlRequestId } = await seedParkedRun(projectId, {
      priorOperatorRestarts: 2,
    });

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "restart_node" } },
        userActor,
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // resume is never capped — the operator can always let it continue.
    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
  });

  it("refuses an unknown optionId", async () => {
    const projectId = await seedProject("ni-bad-option");
    const { runId, hitlRequestId } = await seedParkedRun(projectId);

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "not-an-option" } },
        userActor,
        { db, executionHosts: hosts },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

// ---------------------------------------------------------------------------
// T-B7 — workspace-policy degrade (AC-B7)
// ---------------------------------------------------------------------------

describe("T-B7 ADR-161 — a missing checkpoint_ref degrades to keep", () => {
  // Degrading is the SAFE direction: rewinding to a guessed commit would
  // destroy the operator's work, whereas keeping the tree merely does less.
  it("records `keep` when the target has no checkpoint_ref", async () => {
    const projectId = await seedProject("ni-degrade");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    // No workspaces row and no checkpoint_ref anywhere in the ledger.
    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          optionId: "restart_node",
          workspacePolicy: "rewind-to-node-checkpoint",
        },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);

    const attempt = await getAttempt(parkedAttemptId);

    // The EFFECTIVE policy is recorded, not the requested one — the ledger must
    // not claim a rewind that never happened.
    expect(attempt.workspacePolicy).toBe("keep");
    expect((await getHitl(hitlRequestId)).response.workspacePolicy).toBe(
      "keep",
    );
  });
});

// Codex finding 1 (critical) — the workspace policy used to be applied BEFORE
// the HITL row was locked, so a request that lost the race, or a plain replay,
// could `reset --hard` + `git clean -fd` the operator's worktree and only then
// discover the request had already been answered. The stored decision — not the
// arriving payload — is what the run acts on, so only a byte-identical retry
// may re-drive the destructive half.
describe("node_interrupt — a consumed HITL cannot destroy the workspace", () => {
  // Give the target a checkpoint_ref and the run a worktree, so the policy is
  // resolvable and would really be applied — otherwise the degrade-to-keep path
  // would mask whether the ordering fix works.
  async function attachCheckpointAndWorkspace(
    projectId: string,
    slug: string,
    runId: string,
  ): Promise<void> {
    await (db as any)
      .update(schema.nodeAttempts)
      .set({ checkpointRef: `refs/maister/checkpoints/${runId}/a` })
      .where(eq(schema.nodeAttempts.nodeId, EARLIER));
    await (db as any).insert(schema.workspaces).values({
      id: randomUUID(),
      projectId,
      runId,
      branch: "maister/t-1",
      worktreePath: `/tmp/${slug}-wt`,
      parentRepoPath: `/tmp/${slug}`,
      baseBranch: "main",
    });
  }

  it("does NOT rewind when a losing request carries a different decision", async () => {
    const projectId = await seedProject("ni-replay");
    const seeded = await seedParkedRun(projectId);
    const { runId, hitlRequestId, parkedAttemptId } = seeded;

    await attachCheckpointAndWorkspace(projectId, "ni-replay", runId);

    // The winner keeps the work.
    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(first.status).toBe(202);
    expect(applyWorkspacePolicy).not.toHaveBeenCalled();

    // A replay arrives asking to throw the worktree away.
    const second = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          optionId: "restart_from",
          targetNodeId: EARLIER,
          workspacePolicy: "fresh-attempt",
        },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(second.status).toBe(200);
    // THE fence: the losing payload must not have touched the filesystem.
    expect(applyWorkspacePolicy).not.toHaveBeenCalled();
    // ...and the winning decision still stands — `resume` keeps the SAME
    // attempt, so a restart that had taken effect would read `Reworked` here.
    expect((await getAttempt(parkedAttemptId)).status).toBe("NeedsInput");
  });

  it("re-drives the rewind for a byte-identical retry", async () => {
    const projectId = await seedProject("ni-retry");
    const { runId, hitlRequestId } = await seedParkedRun(projectId);

    await attachCheckpointAndWorkspace(projectId, "ni-retry", runId);
    const body = {
      optionId: "restart_from",
      targetNodeId: EARLIER,
      workspacePolicy: "fresh-attempt",
    };

    expect(
      (
        await respondToHitl({ runId, hitlRequestId, body }, userActor, {
          db,
          executionHosts: hosts,
        })
      ).status,
    ).toBe(202);
    expect(applyWorkspacePolicy).toHaveBeenCalledTimes(1);

    // A same-payload retry is the durable recovery path for a handoff lost
    // between the marker commit and the git op — it must converge, not refuse.
    expect(
      (
        await respondToHitl({ runId, hitlRequestId, body }, userActor, {
          db,
          executionHosts: hosts,
        })
      ).status,
    ).toBe(200);
    expect(applyWorkspacePolicy).toHaveBeenCalledTimes(2);
  });
});

// Codex finding 2 — the keep-alive sweeper can idle a parked run to
// NeedsInputIdle while the operator is still deciding. The old bare
// scheduleResume drove runFlow, which only claims NeedsInput, so the answer was
// accepted and the run stayed asleep with no way to recover it.
describe("node_interrupt — an answer after the idle sweep still wakes the run", () => {
  it("un-idles NeedsInputIdle instead of silently accepting", async () => {
    const projectId = await seedProject("ni-idle");
    const { runId, hitlRequestId, parkedAttemptId } =
      await seedParkedRun(projectId);

    // The sweeper checkpointed the run while the operator was reading.
    await (db as any)
      .update(schema.runs)
      .set({
        status: "NeedsInputIdle",
        checkpointAt: new Date(),
        keepaliveUntil: null,
      })
      .where(eq(schema.runs.id, runId));

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "restart_node" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);

    const run = await getRun(runId);

    // Claimed out of the idle state — the runner owns NeedsInput → Running from
    // here. Left at NeedsInputIdle the run would never resume.
    expect(run.status).toBe("NeedsInput");
    expect(run.checkpointAt).toBeNull();
    // The decision itself still landed.
    expect((await getAttempt(parkedAttemptId)).status).toBe("Reworked");
  });
});

// Codex finding 6 — `markDownstreamStale` stales exactly the ids it is handed;
// it derives nothing from the graph. Passing only [targetNodeId] staled the one
// node about to be re-run anyway and left every node BETWEEN the target and the
// interrupted node `Succeeded` with `passed` gates — evidence produced under a
// run state the jump-back has just invalidated.
describe("node_interrupt — restart_from stales the whole downstream", () => {
  const MANIFEST = {
    schemaVersion: 1,
    name: "ni-stale",
    engine: "3.4.0",
    nodes: [
      {
        id: EARLIER,
        type: "ai_coding",
        action: { prompt: "plan" },
        transitions: { success: "middle" },
      },
      {
        id: "middle",
        type: "ai_coding",
        action: { prompt: "middle" },
        gates: [{ id: "middle-check", kind: "command_check", command: "true" }],
        transitions: { success: INTERRUPTED },
      },
      {
        id: INTERRUPTED,
        type: "ai_coding",
        action: { prompt: "implement" },
        transitions: { success: "done" },
      },
    ],
  };

  it("stales an intermediate node and its passed gate", async () => {
    const seeded = await seedGraphRun(db, MANIFEST, {
      flowRevision: true,
      run: { status: "NeedsInput", currentStepId: INTERRUPTED },
    });
    const { runId } = seeded;

    async function attempt(
      nodeId: string,
      attemptNo: number,
      status: string,
    ): Promise<string> {
      const id = randomUUID();

      await (db as any).insert(schema.nodeAttempts).values({
        id,
        runId,
        nodeId,
        nodeType: "ai_coding",
        attempt: attemptNo,
        status,
        startedAt: new Date(Date.now() - 60_000),
      });

      return id;
    }

    await attempt(EARLIER, 1, "Succeeded");
    const middleId = await attempt("middle", 1, "Succeeded");

    await attempt(INTERRUPTED, 1, "NeedsInput");
    await (db as any).insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: middleId,
      gateId: "middle-check",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
    });

    const hitlRequestId = randomUUID();

    await (db as any).insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId,
      stepId: INTERRUPTED,
      kind: "node_interrupt",
      prompt: "interrupted",
      schema: { kind: "node_interrupt", nodeId: INTERRUPTED },
    });

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "restart_from", targetNodeId: EARLIER },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);

    const middle = await getAttempt(middleId);

    // The node between the jump target and the interrupt must lose its
    // Succeeded verdict — its work was produced under a superseded state.
    expect(middle.status).toBe("Stale");

    const [gate] = await (db as any)
      .select()
      .from(schema.gateResults)
      .where(eq(schema.gateResults.nodeAttemptId, middleId));

    expect(gate.status).toBe("stale");
  });
});

// ADR-164 D3: a restart appends a fresh attempt under a NEW driver generation —
// the restart claim mints a `node_interrupt` placement on the local host, and a
// `resume` (same attempt continues) reuses the current epoch, minting nothing.
describe("node_interrupt — execution-assignment placement (ADR-164)", () => {
  async function assignmentsOf(runId: string) {
    return (db as any)
      .select()
      .from(schema.executionAssignments)
      .where(eq(schema.executionAssignments.runId, runId));
  }

  it("restart_node mints an active node_interrupt assignment inside the restart claim", async () => {
    const projectId = await seedProject("ni-mint");
    const { runId, hitlRequestId } = await seedParkedRun(projectId);

    expect(await assignmentsOf(runId)).toHaveLength(0);

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "restart_node", workspacePolicy: "keep" },
      },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    const rows = await assignmentsOf(runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "active",
      placementReason: "node_interrupt",
    });
    const run = await getRun(runId);

    expect(run.executionAssignmentId).toBe(rows[0].id);
  });

  it("resume mints nothing — the same driver generation continues", async () => {
    const projectId = await seedProject("ni-no-mint");
    const { runId, hitlRequestId } = await seedParkedRun(projectId);

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(202);
    expect(await assignmentsOf(runId)).toHaveLength(0);
  });
});
