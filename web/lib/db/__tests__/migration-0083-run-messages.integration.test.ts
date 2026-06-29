import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase;
type CountRow = { n: string };
type NullableRow = { is_nullable: "YES" | "NO" };
type DeleteRuleRow = { delete_rule: string };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_migration_0083_test")
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

async function seedRun(): Promise<{ projectId: string; runId: string }> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    flowVersion: "v1",
    flowRevision: "manual",
  });

  return { projectId, runId };
}

async function seedNodeAttempt(runId: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
  });

  return id;
}

describe("migration 0083 — scratch_messages → run_messages", () => {
  it("renamed the table (run_messages present, scratch_messages gone)", async () => {
    const present = await db.execute<CountRow>(
      sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'run_messages'`,
    );
    const gone = await db.execute<CountRow>(
      sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'scratch_messages'`,
    );

    expect(present.rows[0].n).toBe("1");
    expect(gone.rows[0].n).toBe("0");
  });

  it("added a nullable node_attempt_id column with a CASCADE FK to node_attempts", async () => {
    const nullable = await db.execute<NullableRow>(
      sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'run_messages' AND column_name = 'node_attempt_id'`,
    );

    expect(nullable.rows[0].is_nullable).toBe("YES");

    const rule = await db.execute<DeleteRuleRow>(
      sql`SELECT rc.delete_rule
          FROM information_schema.referential_constraints rc
          WHERE rc.constraint_name = 'run_messages_node_attempt_id_node_attempts_id_fk'`,
    );

    expect(rule.rows[0].delete_rule).toBe("CASCADE");
  });

  it("repointed run_id to the general runs table (CASCADE)", async () => {
    const rule = await db.execute<DeleteRuleRow>(
      sql`SELECT rc.delete_rule
          FROM information_schema.referential_constraints rc
          WHERE rc.constraint_name = 'run_messages_run_id_runs_id_fk'`,
    );

    expect(rule.rows[0].delete_rule).toBe("CASCADE");
  });

  it("keeps scratch (NULL attempt) and flow (non-null attempt) rows coexisting, with NULLS-NOT-DISTINCT uniqueness on each side", async () => {
    const { runId } = await seedRun();
    const attemptId = await seedNodeAttempt(runId);

    // Scratch row: NULL node_attempt_id, sequence 0.
    await db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: null,
      sequence: 0,
      role: "user",
      content: "hello",
    });

    // A second scratch row with the SAME (run_id, sequence) and NULL attempt
    // must be rejected — NULLS NOT DISTINCT preserves scratch's (run_id,
    // sequence) invariant.
    await expect(
      db.insert(schema.runMessages).values({
        id: randomUUID(),
        runId,
        nodeAttemptId: null,
        sequence: 0,
        role: "assistant",
        content: "dup",
      }),
    ).rejects.toThrow();

    // A flow row with the SAME (run_id, sequence) but a non-null attempt
    // coexists (different node_attempt_id) — no collision with the scratch row.
    await db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId,
      nodeAttemptId: attemptId,
      sequence: 0,
      role: "assistant",
      content: "flow output",
    });

    // ...but a duplicate flow (run_id, attempt, sequence) is rejected.
    await expect(
      db.insert(schema.runMessages).values({
        id: randomUUID(),
        runId,
        nodeAttemptId: attemptId,
        sequence: 0,
        role: "assistant",
        content: "dup flow",
      }),
    ).rejects.toThrow();

    const count = await db.execute<CountRow>(
      sql`SELECT count(*)::text AS n FROM run_messages WHERE run_id = ${runId}`,
    );

    expect(count.rows[0].n).toBe("2");
  });
});
