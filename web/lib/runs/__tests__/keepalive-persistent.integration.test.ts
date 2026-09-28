// M37 Phase 8 (ADR-099): the keep-alive sweeper Pass-2 (24h NeedsInputIdle →
// Abandoned) EXCLUDES persistent swarm members — they park indefinitely until
// re-messaged or their tree terminates. A non-persistent NeedsInputIdle agent
// past the TTL still abandons. Real testcontainer so the persistent=false SQL
// filter is exercised.

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let runPass2: typeof import("@/lib/runs/keepalive-sweeper").runPass2;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "keepalive_persistent_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ runPass2 } = await import("@/lib/runs/keepalive-sweeper"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
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

// A NeedsInputIdle flow run checkpointed 48h ago, parked on a node interrupt.
async function seedIdleInterruptedFlow(interrupt: {
  cause: "host_pressure" | "operator";
  answered: boolean;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status",
       "current_step_id", "flow_version", "checkpoint_at")
     VALUES ($1, 'flow', $2, 'NeedsInputIdle', 'implement', 'v1.0.0',
             now() - interval '48 hours')`,
    [runId, projectId],
  );
  await pool.query(
    `INSERT INTO "hitl_requests" ("id", "run_id", "step_id", "kind", "prompt",
       "schema", "response", "responded_at")
     VALUES ($1, $2, 'implement', 'node_interrupt', 'paused', $3::jsonb,
             $4::jsonb, $5)`,
    [
      randomUUID(),
      runId,
      JSON.stringify({
        kind: "node_interrupt",
        nodeId: "implement",
        cause: interrupt.cause,
        actor: {
          type: interrupt.cause === "host_pressure" ? "system" : "user",
        },
      }),
      interrupt.answered
        ? JSON.stringify({
            optionId: "resume",
            actor: { type: "system" },
            cause: interrupt.cause,
          })
        : null,
      interrupt.answered ? new Date(Date.now() - 47 * 3_600_000) : null,
    ],
  );

  return runId;
}

// ADR-183 amendment 2026-09-28 (decision 4): the TTL measures operator
// silence. A host park, and any resume the manager still owes, is not silence.
describe("keepalive Pass-2 never abandons a host park", () => {
  it("skips a run whose resume is owed and a flow run parked on a host-pressure interrupt; an operator-silent run still abandons", async () => {
    await seedProject();
    const owedAgent = await seedIdleAgent(false);

    await pool.query(
      `UPDATE "runs" SET "resume_requested_at" = now() - interval '47 hours' WHERE "id" = $1`,
      [owedAgent],
    );
    const hostParked = await seedIdleInterruptedFlow({
      cause: "host_pressure",
      answered: false,
    });
    const autoResumedDeferred = await seedIdleInterruptedFlow({
      cause: "host_pressure",
      answered: true,
    });
    const operatorSilent = await seedIdleInterruptedFlow({
      cause: "operator",
      answered: false,
    });
    const silentAgent = await seedIdleAgent(false);

    const abandoned = await runPass2(db);

    expect({
      owedAgent: await statusOf(owedAgent),
      hostParked: await statusOf(hostParked),
      autoResumedDeferred: await statusOf(autoResumedDeferred),
      operatorSilent: await statusOf(operatorSilent),
      silentAgent: await statusOf(silentAgent),
    }).toEqual({
      owedAgent: "NeedsInputIdle",
      hostParked: "NeedsInputIdle",
      autoResumedDeferred: "NeedsInputIdle",
      operatorSilent: "Abandoned",
      silentAgent: "Abandoned",
    });
    expect(abandoned).toBe(2);
  });
});
