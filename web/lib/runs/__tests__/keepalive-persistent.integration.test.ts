// M37 Phase 8 (ADR-099): the keep-alive sweeper Pass-2 (24h NeedsInputIdle →
// Abandoned) EXCLUDES persistent swarm members — they park indefinitely until
// re-messaged or their tree terminates. A non-persistent NeedsInputIdle agent
// past the TTL still abandons. Real testcontainer so the persistent=false SQL
// filter is exercised.

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
  afterEach,
  beforeAll,
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

let runPass2: typeof import("@/lib/runs/keepalive-sweeper").runPass2;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("keepalive_persistent_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ runPass2 } = await import("@/lib/runs/keepalive-sweeper"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

afterEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(): Promise<void> {
  projectId = randomUUID();
  executorId = randomUUID();

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
}

// A NeedsInputIdle agent run checkpointed 48h ago (past the 24h TTL).
async function seedIdleAgent(persistent: boolean): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "agent_workspace",
       "persistent", "addressable_key", "checkpoint_at")
     VALUES ($1, 'agent', NULL, $2, 'NeedsInputIdle', 'agent', 'manual', 'none',
             $3, $4, now() - interval '48 hours')`,
    [runId, projectId, persistent, persistent ? "reviewer" : null],
  );
  await pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id", "runner_snapshot")
     VALUES ($1, $2, 'default', $3, '{"capabilityAgent":"claude"}'::jsonb)`,
    [randomUUID(), runId, executorId],
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

describe("keepalive Pass-2 persistent exclusion (M37 Phase 8 T8.1)", () => {
  it("a persistent NeedsInputIdle past 24h is NOT abandoned; a non-persistent one IS", async () => {
    await seedProject();
    const persistentRunId = await seedIdleAgent(true);
    const ephemeralRunId = await seedIdleAgent(false);

    const abandoned = await runPass2(db);

    // Exactly one row abandoned — the non-persistent one.
    expect(abandoned).toBe(1);
    expect(await statusOf(persistentRunId)).toBe("NeedsInputIdle");
    expect(await statusOf(ephemeralRunId)).toBe("Abandoned");
  });
});
