import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { promoteNextPending, tryStartRun } from "@/lib/scheduler";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let originalRunsCap: string | undefined;
let originalAgentsCap: string | undefined;

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
  originalRunsCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  originalAgentsCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "2";
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4)`,
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
  await pool.query(
    `INSERT INTO "agents" ("id", "scope", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ('budget-agent', 'platform', 'A', 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
  );
});

afterEach(() => {
  if (originalRunsCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalRunsCap;
  }
  if (originalAgentsCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = originalAgentsCap;
  }
});

async function insertRun(args: {
  kind: "flow" | "agent";
  status: string;
  startedOffsetMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const startedAt = new Date(Date.now() + (args.startedOffsetMs ?? 0));

  if (args.kind === "agent") {
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "started_at")
       VALUES ($1, 'agent', 'budget-agent', 'manual', $2, 'agent', 'manual', $3, $4)`,
      [id, projectId, args.status, startedAt],
    );
  } else {
    const flowId = randomUUID();

    await pool.query(
      `INSERT INTO "flows" ("id", "project_id", "flow_ref_id", "source", "version", "installed_path", "manifest", "schema_version")
       VALUES ($1, $2, $3, 'local', 'v1', '/tmp/flow', '{}'::jsonb, 1)`,
      [flowId, projectId, `f-${id.slice(0, 8)}`],
    );
    const taskId = randomUUID();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "flow_id")
       VALUES ($1, $2, $3, 't', 'p', $4)`,
      [taskId, projectId, Math.floor(Math.random() * 1_000_000), flowId],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "task_id", "flow_id", "project_id", "flow_version", "flow_revision", "status", "started_at")
       VALUES ($1, 'flow', $2, $3, $4, 'v1', 'unknown', $5, $6)`,
      [id, taskId, flowId, projectId, args.status, startedAt],
    );
  }

  return id;
}

async function runStatus(id: string): Promise<string> {
  const res = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    id,
  ]);

  return res.rows[0].status as string;
}

describe("M33 split concurrency budgets", () => {
  it("a full flow pool does not block an agent start, and vice versa", async () => {
    // Fill the flow pool (cap 2).
    await insertRun({ kind: "flow", status: "Running" });
    await insertRun({ kind: "flow", status: "Running" });

    const agentPending = await insertRun({ kind: "agent", status: "Pending" });
    const agentResult = await tryStartRun(agentPending, { db });

    expect(agentResult).toEqual({ started: true });

    // Agent pool now full (cap 1) — a flow run must still queue on ITS pool,
    // and a second agent run queues at position 1 of the agent queue.
    const flowPending = await insertRun({
      kind: "flow",
      status: "Pending",
      startedOffsetMs: 10,
    });
    const flowResult = await tryStartRun(flowPending, { db });

    expect(flowResult).toEqual({ started: false, queuePosition: 1 });

    const agentPending2 = await insertRun({
      kind: "agent",
      status: "Pending",
      startedOffsetMs: 20,
    });
    const agentResult2 = await tryStartRun(agentPending2, { db });

    expect(agentResult2).toEqual({ started: false, queuePosition: 1 });
  });

  it("promoteNextPending promotes only within the requested pool", async () => {
    const agentQueued = await insertRun({ kind: "agent", status: "Pending" });
    const flowQueued = await insertRun({
      kind: "flow",
      status: "Pending",
      startedOffsetMs: -60_000,
    });

    // Promote the AGENT pool: the older flow Pending must be ignored and the
    // promoted agent run dispatches through startAgentRun (stubbed).
    const dispatched: string[] = [];
    const promoted = await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => void dispatched.push(id),
      runFlow: () => undefined,
    });

    expect(promoted.promotedRunId).toBe(agentQueued);
    expect(await runStatus(agentQueued)).toBe("Running");
    expect(await runStatus(flowQueued)).toBe("Pending");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual([agentQueued]);
  });
});
