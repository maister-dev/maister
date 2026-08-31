// ADR-160: respondToHitl for the `node_interrupt` kind — a four-way operator
// fork over a paused agent node. Mirrors hitl-hook-trip.integration.test.ts
// (testcontainer DB; runFlow + authz mocked).
//
// Owns test ids: T-B4 (human-actor-only at the chokepoint), T-B6 (restart_node
// closes Reworked/operator_interrupt and captures the correction), T-B8
// (restart_from stales downstream), T-B9 (resume keeps the same attempt), and
// the safety-cap + forward-skip refusals.

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
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn(async () => {}) }));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "hitl_node_interrupt_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
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
        { db },
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
      { db },
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
      { db },
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
        { db },
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
      { db },
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
      { db },
    );
    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
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
        { db },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // resume is never capped — the operator can always let it continue.
    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "resume" } },
      userActor,
      { db },
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
        { db },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});
