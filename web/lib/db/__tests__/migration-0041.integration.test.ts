import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm@0.36 ships duplicate peer-dep variants in pnpm
// (one with better-sqlite3, one without). Typed table imports from
// `@/lib/db/schema` clash with the test-file's own drizzle copy. Runtime
// works; we cast to `any` to silence the type-only conflict.
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

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

async function columnInfo(table: string, column: string) {
  const r = await pool.query(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );

  return r.rows[0] as
    | { data_type: string; is_nullable: "YES" | "NO"; column_default: string | null }
    | undefined;
}

async function seedChain() {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlId = randomUUID();
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@test.local`,
  });

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
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
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.hitlRequests).values({
    id: hitlId,
    runId,
    stepId: "review-1",
    kind: "human",
    schema: { schemaVersion: 1, fields: [] },
    prompt: "Review?",
  });

  return { projectId, runId, hitlId, userId };
}

describe("migration 0041 — node_attempts policy columns", () => {
  it("adds checkpoint_ref (nullable text)", async () => {
    const c = await columnInfo("node_attempts", "checkpoint_ref");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("text");
    expect(c?.is_nullable).toBe("YES");
  });

  it("adds session_policy (nullable text)", async () => {
    const c = await columnInfo("node_attempts", "session_policy");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("text");
    expect(c?.is_nullable).toBe("YES");
  });

  it("adds session_fallback (boolean, not null, default false)", async () => {
    const c = await columnInfo("node_attempts", "session_fallback");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("boolean");
    expect(c?.is_nullable).toBe("NO");
    expect(c?.column_default).toBe("false");
  });

  it("adds auto_retry (boolean, not null, default false)", async () => {
    const c = await columnInfo("node_attempts", "auto_retry");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("boolean");
    expect(c?.is_nullable).toBe("NO");
    expect(c?.column_default).toBe("false");
  });
});

describe("migration 0041 — hitl_requests review-diff columns", () => {
  it("adds review_tip_sha (nullable text)", async () => {
    const c = await columnInfo("hitl_requests", "review_tip_sha");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("text");
    expect(c?.is_nullable).toBe("YES");
  });

  it("adds dirty_resolution (nullable text)", async () => {
    const c = await columnInfo("hitl_requests", "dirty_resolution");

    expect(c).toBeDefined();
    expect(c?.data_type).toBe("text");
    expect(c?.is_nullable).toBe("YES");
  });
});

describe("migration 0041 — gate_chat_messages table", () => {
  it("has the full column set", async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'gate_chat_messages'`,
    );
    const names = r.rows.map((x: { column_name: string }) => x.column_name);

    expect(names.sort()).toEqual(
      [
        "id",
        "run_id",
        "hitl_request_id",
        "node_id",
        "gate_attempt",
        "role",
        "author_user_id",
        "author_label",
        "body",
        "acp_session_id",
        "seq",
        "mutation_reverted",
        "created_at",
      ].sort(),
    );
  });

  it("mutation_reverted is boolean not null default false", async () => {
    const c = await columnInfo("gate_chat_messages", "mutation_reverted");

    expect(c?.data_type).toBe("boolean");
    expect(c?.is_nullable).toBe("NO");
    expect(c?.column_default).toBe("false");
  });

  it("has indexes on run_id and hitl_request_id", async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'gate_chat_messages'`,
    );
    const defs = r.rows.map((x: { indexdef: string }) => x.indexdef).join("\n");

    expect(defs).toMatch(/\(run_id\)/);
    expect(defs).toMatch(/\(hitl_request_id\)/);
  });

  it("cascades on run delete and nulls author on user delete", async () => {
    const { runId, hitlId, userId } = await seedChain();
    const msgId = randomUUID();

    await db.insert(schema.gateChatMessages).values({
      id: msgId,
      runId,
      hitlRequestId: hitlId,
      nodeId: "review-1",
      gateAttempt: 1,
      role: "user",
      authorUserId: userId,
      authorLabel: "Test User",
      body: "why did you change this file?",
      seq: 1,
    });

    await db.delete(schema.users).where(eq(schema.users.id, userId));

    const afterUserDelete = await pool.query(
      `SELECT author_user_id, mutation_reverted FROM gate_chat_messages WHERE id = $1`,
      [msgId],
    );

    expect(afterUserDelete.rows[0].author_user_id).toBeNull();
    expect(afterUserDelete.rows[0].mutation_reverted).toBe(false);

    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);

    const afterRunDelete = await pool.query(
      `SELECT id FROM gate_chat_messages WHERE id = $1`,
      [msgId],
    );

    expect(afterRunDelete.rowCount).toBe(0);
  });

  it("rejects a role outside the user|agent allow-list", async () => {
    const { runId, hitlId } = await seedChain();

    await expect(
      pool.query(
        `INSERT INTO gate_chat_messages
           (id, run_id, hitl_request_id, node_id, gate_attempt, role, author_label, body, seq)
         VALUES ($1, $2, $3, 'review-1', 1, 'system', 'X', 'nope', 1)`,
        [randomUUID(), runId, hitlId],
      ),
    ).rejects.toThrow();
  });
});

describe("migration 0041 — single-delta guard", () => {
  it("0041 SQL does not re-emit run_schedules DDL (stale-baseline regression)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve("lib/db/migrations");
    const file = fs
      .readdirSync(dir)
      .find((f) => f.startsWith("0041_") && f.endsWith(".sql"));

    expect(file).toBeDefined();

    const sqlText = fs.readFileSync(path.join(dir, file as string), "utf8");

    expect(sqlText).not.toMatch(/run_schedules/);
    expect(sqlText).toMatch(/gate_chat_messages/);
    expect(sqlText).toMatch(/checkpoint_ref/);
    expect(sqlText).toMatch(/review_tip_sha/);
  });
});
