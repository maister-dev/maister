import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  crashResumedRun,
  crashRunningRun,
  failResumedRun,
  markAbandoned,
} from "@/lib/runs/state-transitions";
import {
  createGateResult,
  markGateFailed,
  markGatePassed,
} from "@/lib/flows/graph/gate-store";
import { runPass2 } from "@/lib/runs/keepalive-sweeper";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T6 — run-terminal + gate.failed domain-event pairing (ADR-086, AC1).
//
//   T-E5: every terminal state-transition helper that emits a webhook also
//         captures exactly one PAIRED domain event in the SAME transaction;
//         a CAS-losing call captures nothing.
//   T-E6: a gate flip to `failed` captures one `gate.failed` domain event;
//         a flip to `passed` captures NO domain event (webhook-only).
//   T-E7: the keepalive sweeper's TTL pass (NeedsInputIdle → Abandoned) runs
//         ONE transaction folding the runs flip + the hitl close-out, and
//         emits BOTH the run.abandoned domain event AND the previously
//         missing run.abandoned webhook (source: "ttl").
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.domainEvents);
});

type RunStatus =
  | "Pending"
  | "Running"
  | "NeedsInput"
  | "NeedsInputIdle"
  | "Review"
  | "Crashed";

async function seedRun(
  status: RunStatus,
  opts: { checkpointAt?: Date } = {},
): Promise<{
  projectId: string;
  runId: string;
  taskId: string;
  flowId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status,
    ...(opts.checkpointAt ? { checkpointAt: opts.checkpointAt } : {}),
  });

  return { projectId, runId, taskId, flowId };
}

async function domainRows(runId: string): Promise<Record<string, unknown>[]> {
  return (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId))) as Record<string, unknown>[];
}

describe("T-E5 — paired domain emission at terminal state transitions", () => {
  it("markAbandoned captures exactly one run.abandoned paired with the webhook", async () => {
    const ids = await seedRun("Review");

    const result = await markAbandoned(ids.runId, { db });

    expect(result.ok).toBe(true);

    const rows = await domainRows(ids.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run.abandoned");
    expect(rows[0].projectId).toBe(ids.projectId);
    expect(rows[0].taskId).toBe(ids.taskId);
    expect(rows[0].payload).toEqual({
      runId: ids.runId,
      taskId: ids.taskId,
      flowId: ids.flowId,
      runKind: "flow",
      reason: "user",
      // M37: run-terminal payloads fold the emitting run's parent_run_id (null
      // for a top-level/parentless run) so the orchestrator resume/auto-launch
      // consumers can route to the parent.
      parentRunId: null,
    });

    const webhookRows = await db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.runId, ids.runId));

    expect(webhookRows).toHaveLength(1);
  });

  it("failResumedRun captures exactly one run.failed with the failure reason", async () => {
    const ids = await seedRun("NeedsInputIdle");

    const result = await failResumedRun(ids.runId, "CHECKPOINT", { db });

    expect(result.ok).toBe(true);

    const rows = await domainRows(ids.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run.failed");
    expect(rows[0].payload).toEqual({
      runId: ids.runId,
      taskId: ids.taskId,
      flowId: ids.flowId,
      runKind: "flow",
      reason: "CHECKPOINT",
      parentRunId: null,
    });
  });

  it("a CAS-losing transition captures nothing (loser path)", async () => {
    const ids = await seedRun("Running");

    const result = await failResumedRun(ids.runId, "CHECKPOINT", { db });

    expect(result.ok).toBe(false);
    expect(await domainRows(ids.runId)).toHaveLength(0);
  });

  it("crashRunningRun captures exactly one run.crashed", async () => {
    const ids = await seedRun("Running");

    const result = await crashRunningRun(ids.runId, "worktree-gone", { db });

    expect(result.ok).toBe(true);

    const rows = await domainRows(ids.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run.crashed");
    expect((rows[0].payload as Record<string, unknown>).reason).toBe(
      "worktree-gone",
    );
  });

  it("crashResumedRun captures exactly one run.crashed", async () => {
    const ids = await seedRun("NeedsInput");

    const result = await crashResumedRun(ids.runId, "resume-timeout", { db });

    expect(result.ok).toBe(true);

    const rows = await domainRows(ids.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run.crashed");
  });
});

describe("T-E6 — gate.failed pairing on gate terminal flips", () => {
  async function seedGate(): Promise<{
    runId: string;
    gateResultId: string;
    nodeAttemptId: string;
  }> {
    const ids = await seedRun("Running");
    const nodeAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId: ids.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
    });

    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId,
      gateId: "tests",
      kind: "command_check",
      mode: "blocking",
      status: "running",
      db,
    });

    return { runId: ids.runId, gateResultId: id, nodeAttemptId };
  }

  it("markGateFailed captures exactly one gate.failed domain event", async () => {
    const g = await seedGate();

    await markGateFailed(g.gateResultId, undefined, db);

    const rows = await domainRows(g.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("gate.failed");
    expect(rows[0].payload).toEqual({
      runId: g.runId,
      gateId: "tests",
      gateKind: "command_check",
      gateResultId: g.gateResultId,
      nodeAttemptId: g.nodeAttemptId,
      blocking: true,
    });
  });

  it("markGatePassed captures NO domain event (webhook-only)", async () => {
    const g = await seedGate();

    await markGatePassed(g.gateResultId, undefined, db);

    expect(await domainRows(g.runId)).toHaveLength(0);
  });
});

describe("T-E7 — runPass2 TTL abandon: one tx, both emits", () => {
  it("folds the runs flip + hitl close-out and emits domain + webhook run.abandoned", async () => {
    const ids = await seedRun("NeedsInputIdle", {
      checkpointAt: new Date(Date.now() - 25 * 3600_000),
    });

    const hitlId = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id: hitlId,
      runId: ids.runId,
      stepId: "review",
      kind: "human",
      prompt: "please review",
    });

    const abandoned = await runPass2(db as any);

    expect(abandoned).toBe(1);

    const runRow = (await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, ids.runId))) as Record<string, unknown>[];

    expect(runRow[0].status).toBe("Abandoned");

    const hitlRow = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlId))) as Record<string, unknown>[];

    expect(hitlRow[0].respondedAt).not.toBeNull();

    const rows = await domainRows(ids.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run.abandoned");
    expect((rows[0].payload as Record<string, unknown>).reason).toBe("ttl");

    const webhookRows = (await db
      .select()
      .from(schema.webhookEvents)
      .where(
        and(
          eq(schema.webhookEvents.runId, ids.runId),
          eq(schema.webhookEvents.type, "run.abandoned"),
        ),
      )) as Record<string, unknown>[];

    expect(webhookRows).toHaveLength(1);
    expect((webhookRows[0].data as Record<string, unknown>).source).toBe("ttl");
  });
});
