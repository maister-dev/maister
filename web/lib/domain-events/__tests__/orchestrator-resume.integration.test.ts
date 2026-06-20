// M37 (ADR-098) T5.2: the orchestrator_resume consumer. A child-terminal event
// wakes a PARKED flow coordinator (run_kind='flow', status='WaitingOnChildren').
// The re-drive is injected (synchronous resumeFlow spy) so the test asserts the
// wake DECISION + the single-winner CAS without spawning a real ACP session.
// Asserts:
//   (2) last child done → parent flips WaitingOnChildren→Running + respawn once;
//       re-deliver SAME event → parent already Running → NO second respawn (CAS);
//   (3) a done child while siblings pending → no wake; the LAST done wakes once;
//   (4) a failed/crashed child wakes the parent even with other pending children
//       (deferred-release);
//   (5) two child terminals → markResumedFromWait succeeds once → exactly one
//       respawn (concurrent-resume convergence);
//   + a non-flow parent (agent orchestrator) is NEVER driven into the flow path.

import type { DomainEventRow } from "@/lib/db/schema";
import type { RunFlowOptions } from "@/lib/flows/graph/runner-core";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let buildOrchestratorResumeConsumer: typeof import("@/lib/domain-events/orchestrator-resume").buildOrchestratorResumeConsumer;
let emitDomainEvent: typeof import("@/lib/domain-events/outbox").emitDomainEvent;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("orch_resume_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ buildOrchestratorResumeConsumer } = await import(
    "@/lib/domain-events/orchestrator-resume"
  ));
  ({ emitDomainEvent } = await import("@/lib/domain-events/outbox"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;
let flowId: string;

beforeEach(async () => {
  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await (db as any).insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "orc",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/orc",
    manifest: { schemaVersion: 1, name: "Orc", nodes: [] },
    schemaVersion: 1,
  });
});

// A PARKED flow orchestrator (run_kind='flow', WaitingOnChildren, at node
// "coordinate", acp handle retained).
async function seedParkedOrchestrator(runKind = "flow"): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "orc",
    prompt: "coordinate",
    flowId,
  });
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "current_step_id", "acp_session_id", "flow_version", "flow_revision", "runner_id")
     VALUES ($1, $2, $3, $4, $5, 'WaitingOnChildren', 'coordinate', 'acp-coord-1', 'v1.0.0', 'unknown', $6)`,
    [runId, runKind, projectId, taskId, flowId, executorId],
  );

  return runId;
}

// A child run under the orchestrator + its emitted run-terminal event.
async function seedChildTerminal(args: {
  parentRunId: string;
  // M37 (ADR-100): "Review" emits run.review (settled, not terminal) — the child
  // produced a worktree diff and the coordinator must be woken to act on it.
  outcome: "Done" | "Failed" | "Crashed" | "Abandoned" | "Review";
}): Promise<DomainEventRow> {
  const childTaskId = randomUUID();
  const childRunId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: childTaskId,
    projectId,
    title: "child",
    prompt: "p",
    flowId,
  });
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, $5, 'v1.0.0', 'unknown', $6, $6, $7)`,
    [
      childRunId,
      projectId,
      childTaskId,
      flowId,
      args.outcome,
      args.parentRunId,
      executorId,
    ],
  );

  const kind =
    args.outcome === "Done"
      ? "run.done"
      : args.outcome === "Review"
        ? "run.review"
        : args.outcome === "Failed"
          ? "run.failed"
          : args.outcome === "Crashed"
            ? "run.crashed"
            : "run.abandoned";

  await emitDomainEvent({
    db,
    kind: kind as "run.done",
    projectId,
    taskId: childTaskId,
    runId: childRunId,
    actor: { type: "system", id: null },
    parentRunId: args.parentRunId,
    payload: { runKind: "agent", status: args.outcome },
  });

  const rows = (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, childRunId))) as DomainEventRow[];

  return rows[0];
}

// A pending (non-terminal) sibling child — keeps the batch incomplete.
async function seedPendingChild(parentRunId: string): Promise<void> {
  const t = randomUUID();
  const r = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: t,
    projectId,
    title: "pending",
    prompt: "p",
    flowId,
  });
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, 'Running', 'v1.0.0', 'unknown', $5, $5, $6)`,
    [r, projectId, t, flowId, parentRunId, executorId],
  );
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0].status;
}

describe("orchestrator_resume consumer (M37 T5.2)", () => {
  it("(2) last child done → wakes the parent exactly once; redelivery is a no-op (CAS)", async () => {
    const parentRunId = await seedParkedOrchestrator();
    const event = await seedChildTerminal({ parentRunId, outcome: "Done" });

    const resumed: Array<{ runId: string; opts: RunFlowOptions }> = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId, opts) => {
        resumed.push({ runId, opts });
      },
    });

    await consumer.handle([event]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].runId).toBe(parentRunId);
    expect(resumed[0].opts.orchestratorResume).toEqual({
      targetStepId: "coordinate",
    });

    // Re-deliver the SAME event → the parent is already Running → CAS lost → no
    // second respawn.
    await consumer.handle([event]);
    expect(resumed).toHaveLength(1);
  });

  it("(3) a done child while a sibling is still pending does NOT wake; the last done does", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedPendingChild(parentRunId); // sibling still Running

    const firstDone = await seedChildTerminal({ parentRunId, outcome: "Done" });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([firstDone]);

    // The sibling is still pending → no wake.
    expect(await statusOf(parentRunId)).toBe("WaitingOnChildren");
    expect(resumed).toHaveLength(0);

    // The pending sibling now finishes Done → batch complete → wake once.
    await pool.query(
      `UPDATE "runs" SET "status" = 'Done' WHERE "parent_run_id" = $1 AND "status" = 'Running'`,
      [parentRunId],
    );
    const lastDone = await seedChildTerminal({ parentRunId, outcome: "Done" });

    await consumer.handle([lastDone]);
    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });

  it("(4) a crashed child wakes the parent even with other pending children (deferred-release)", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedPendingChild(parentRunId); // a sibling is still Running

    const crashed = await seedChildTerminal({
      parentRunId,
      outcome: "Crashed",
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([crashed]);

    // Deferred-release: the failed child wakes the coordinator regardless of the
    // pending sibling.
    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });

  it("(5) two child terminals processed together converge to exactly one respawn", async () => {
    const parentRunId = await seedParkedOrchestrator();

    // Two children, both terminal Done — the batch is complete; either event
    // could wake the parent, but the CAS admits exactly one.
    const e1 = await seedChildTerminal({ parentRunId, outcome: "Done" });
    const e2 = await seedChildTerminal({ parentRunId, outcome: "Done" });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([e1, e2]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });

  // C3 (real two-racer): two dispatcher workers handling the same batch
  // concurrently must still wake the parent exactly once (the markResumedFromWait
  // CAS is the single-winner guard, not in-loop sequencing).
  it("(5b) two concurrent handle() calls wake the parent exactly once", async () => {
    const parentRunId = await seedParkedOrchestrator();
    const e1 = await seedChildTerminal({ parentRunId, outcome: "Done" });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await Promise.all([consumer.handle([e1]), consumer.handle([e1])]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  }, 60_000);

  // M37 (ADR-100): the headline fix — a delegated child reaching REVIEW (a
  // worktree diff, the path the e2e skips with workspace=none) emits run.review
  // and wakes the parked coordinator so it can collect/promote/rework. Before
  // ADR-100 this child emitted nothing and counted as pending forever → deadlock.
  it("(6) a child reaching Review wakes the parked parent (ADR-100)", async () => {
    const parentRunId = await seedParkedOrchestrator();
    const event = await seedChildTerminal({ parentRunId, outcome: "Review" });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });

  // A Review child does NOT block completion (settled), but a still-RUNNING
  // sibling does — so a Review event while a sibling is pending must NOT wake.
  it("(7) a Review child with a pending sibling does NOT wake; settling the last does", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedPendingChild(parentRunId);
    const reviewEvent = await seedChildTerminal({
      parentRunId,
      outcome: "Review",
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([reviewEvent]);

    // Still parked — a non-settled sibling remains.
    expect(await statusOf(parentRunId)).toBe("WaitingOnChildren");
    expect(resumed).toEqual([]);
  });

  it("never drives a NON-flow (agent) orchestrator into the flow resume path", async () => {
    const parentRunId = await seedParkedOrchestrator("agent");
    const event = await seedChildTerminal({ parentRunId, outcome: "Done" });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event]);

    // run_kind='agent' → skipped; status untouched, no flow re-drive.
    expect(await statusOf(parentRunId)).toBe("WaitingOnChildren");
    expect(resumed).toHaveLength(0);
  });
});
