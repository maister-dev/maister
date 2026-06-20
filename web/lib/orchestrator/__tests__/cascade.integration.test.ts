// M36 Phase 7 (T7.4, ADR-095): cascadeAbandonRunTree against a real Postgres
// testcontainer — the bulk status-filtered UPDATE, the un-launched as-plan task
// flip, the run.abandoned emits (with parentRunId), the per-pool promote of a
// freed slot, and idempotency on a second call all depend on real SQL semantics.
//
//   1. orchestrator (WaitingOnChildren) + 2 in-flight children (Running +
//      NeedsInput) + 1 queued child (Pending) + 1 un-launched launch_mode='auto'
//      child task → cascade → all 3 runs Abandoned, the task Abandoned, a
//      run.abandoned event per cascaded run carrying parentRunId + the cascade
//      reason; the freed agent slots let a SEPARATE queued Pending agent run
//      (from another task) promote; the orchestrator row itself is untouched.
//   2. a second cascade call is a no-op (everything already terminal).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
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
// The agent-pool promote dispatches startAgentSession in a background microtask;
// stub it so the test never spawns a real session (the DB Running flip happens
// synchronously in the promote tx, which is what we assert).
vi.mock("@/lib/agents/launch", () => ({
  startAgentSession: vi.fn(async () => undefined),
}));

let cascadeAbandonRunTree: typeof import("@/lib/orchestrator/cascade").cascadeAbandonRunTree;
let countLiveRuns: typeof import("@/lib/scheduler").countLiveRuns;

let projectId: string;
let executorId: string;
let flowId: string;
let originalAgentCap: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cascade_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  originalAgentCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "2";

  ({ cascadeAbandonRunTree } = await import("@/lib/orchestrator/cascade"));
  ({ countLiveRuns } = await import("@/lib/scheduler"));
}, 180_000);

afterAll(async () => {
  if (originalAgentCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = originalAgentCap;
  }
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "workspaces"`);
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

async function seedTask(launchMode: "auto" | "manual" | null): Promise<string> {
  const taskId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    launchMode,
  });

  return taskId;
}

// A flow orchestrator parked at WaitingOnChildren (acp handle retained).
async function seedOrchestrator(taskId: string): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "current_step_id", "acp_session_id", "flow_version", "flow_revision", "runner_id", "root_run_id")
     VALUES ($1, 'flow', $2, $3, $4, 'WaitingOnChildren', 'coordinate', 'acp-coord-1', 'v1.0.0', 'unknown', $5, $1)`,
    [runId, projectId, taskId, flowId, executorId],
  );

  return runId;
}

// An agent child run under the orchestrator (+ optionally a workspace row).
async function seedChild(args: {
  parentRunId: string;
  rootRunId: string;
  status: string;
  startedAt?: Date;
  withWorkspace?: boolean;
}): Promise<string> {
  const taskId = await seedTask("auto");
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id", "started_at")
     VALUES ($1, 'agent', $2, $3, $4, $5, 'v1.0.0', 'unknown', $6, $7, $8, $9)`,
    [
      runId,
      projectId,
      taskId,
      flowId,
      args.status,
      args.parentRunId,
      args.rootRunId,
      executorId,
      args.startedAt ?? new Date(),
    ],
  );

  if (args.withWorkspace) {
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        runId,
        projectId,
        `maister/${runId}`,
        `/tmp/worktrees/${runId}`,
        `/repos/${projectId}`,
      ],
    );
  }

  return runId;
}

// A standalone Pending agent run (no parent) — the queued slot that should
// promote once the cascade frees the agent pool.
async function seedStandalonePendingAgent(startedAt: Date): Promise<string> {
  const taskId = await seedTask("manual");
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "flow_version", "flow_revision", "runner_id", "started_at")
     VALUES ($1, 'agent', $2, $3, $4, 'Pending', 'v1.0.0', 'unknown', $5, $6)`,
    [runId, projectId, taskId, flowId, executorId, startedAt],
  );

  return runId;
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0].status;
}

async function taskStatusOf(taskId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));

  return rows[0].status;
}

describe("cascadeAbandonRunTree (M36 T7.4)", () => {
  it("abandons the whole sub-tree, marks the un-launched as-plan task, frees the pool, is idempotent", async () => {
    const orchTaskId = await seedTask("manual");
    const orchestratorRunId = await seedOrchestrator(orchTaskId);

    // Two in-flight children (hold the agent cap=2) + one queued child.
    const running = await seedChild({
      parentRunId: orchestratorRunId,
      rootRunId: orchestratorRunId,
      status: "Running",
      withWorkspace: true,
    });
    const needsInput = await seedChild({
      parentRunId: orchestratorRunId,
      rootRunId: orchestratorRunId,
      status: "NeedsInput",
    });
    const queued = await seedChild({
      parentRunId: orchestratorRunId,
      rootRunId: orchestratorRunId,
      status: "Pending",
    });

    // An un-launched as-plan (launch_mode='auto') child task linked parent_of
    // FROM the orchestrator's task, with NO run yet.
    const unlaunchedTaskId = await seedTask("auto");

    await pool.query(
      `INSERT INTO "task_relations" ("id", "project_id", "from_task_id", "kind", "to_task_id", "actor_type")
       VALUES ($1, $2, $3, 'parent_of', $4, 'system')`,
      [randomUUID(), projectId, orchTaskId, unlaunchedTaskId],
    );

    // A SEPARATE standalone queued agent run (older → promotes first once the
    // cap frees). It is NOT under the orchestrator.
    const standalonePending = await seedStandalonePendingAgent(
      new Date(Date.now() - 60_000),
    );

    // Before: the agent pool is full (Running + NeedsInput count).
    expect(await countLiveRuns(db, "agent")).toBe(2);

    const result = await cascadeAbandonRunTree(
      orchestratorRunId,
      orchTaskId,
      "user_stopped",
      { db },
    );

    expect(result.cascadedRunCount).toBe(3);
    expect(result.abandonedTaskCount).toBe(1);

    // All three sub-tree runs are Abandoned; the orchestrator itself is NOT.
    expect(await statusOf(running)).toBe("Abandoned");
    expect(await statusOf(needsInput)).toBe("Abandoned");
    expect(await statusOf(queued)).toBe("Abandoned");
    expect(await statusOf(orchestratorRunId)).toBe("WaitingOnChildren");

    // The un-launched as-plan child task is Abandoned.
    expect(await taskStatusOf(unlaunchedTaskId)).toBe("Abandoned");

    // A run.abandoned event per cascaded run, each carrying parentRunId + reason.
    for (const childRunId of [running, needsInput, queued]) {
      const events = await db
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.runId, childRunId),
            eq(schema.domainEvents.kind, "run.abandoned"),
          ),
        );

      expect(events).toHaveLength(1);
      const payload = events[0].payload as Record<string, unknown>;

      expect(payload.parentRunId).toBe(orchestratorRunId);
      expect(payload.reason).toBe("cascade/user_stopped");
      expect(payload.runKind).toBe("agent");
    }

    // The freed agent slots let the standalone queued run promote; no orphan
    // child is left holding a slot.
    expect(await countLiveRuns(db, "agent")).toBeLessThanOrEqual(2);
    expect(await statusOf(standalonePending)).toBe("Running");

    // Idempotent: a second cascade finds everything terminal → cascades nothing.
    const second = await cascadeAbandonRunTree(
      orchestratorRunId,
      orchTaskId,
      "user_stopped",
      { db },
    );

    expect(second.cascadedRunCount).toBe(0);
    expect(second.abandonedTaskCount).toBe(0);
  }, 60_000);
});
