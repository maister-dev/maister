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

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

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

async function seedChain(): Promise<{
  projectId: string;
  runId: string;
  nodeAttemptId: string;
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
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));

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

  const nodeAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "impl",
    nodeType: "ai_coding",
    attempt: 1,
  });

  return { projectId, runId, nodeAttemptId };
}

describe("artifact_instances table", () => {
  it("exists and has the expected columns", async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'artifact_instances'
      ORDER BY ordinal_position
    `);

    const cols = (result.rows as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );

    expect(cols).toContain("id");
    expect(cols).toContain("run_id");
    expect(cols).toContain("node_attempt_id");
    expect(cols).toContain("node_id");
    expect(cols).toContain("attempt");
    expect(cols).toContain("artifact_def_id");
    expect(cols).toContain("kind");
    expect(cols).toContain("producer");
    expect(cols).toContain("locator");
    expect(cols).toContain("uri");
    expect(cols).toContain("hash");
    expect(cols).toContain("size_bytes");
    expect(cols).toContain("validity");
    expect(cols).toContain("required_for");
    expect(cols).toContain("visibility");
    expect(cols).toContain("retention");
    expect(cols).toContain("monotonic_id");
    expect(cols).toContain("superseded_by_id");
    expect(cols).toContain("created_at");
  });

  it("accepts all valid kind values", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const kinds = [
      "diff",
      "log",
      "test_report",
      "lint_report",
      "ai_judgment",
      "human_note",
      "commit_set",
      "checkpoint",
      "preview",
      "generic_file",
    ] as const;

    for (const kind of kinds) {
      await expect(
        db.insert(schema.artifactInstances).values({
          id: `test-${kind}-${randomUUID()}`,
          runId,
          nodeAttemptId,
          nodeId: "impl",
          attempt: 1,
          kind,
          producer: "runner",
          locator: { kind: "inline", text: "test" },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("accepts all valid producer values", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const producers = [
      "runner",
      "projector",
      "takeover",
      "gate",
      "human",
    ] as const;

    for (const producer of producers) {
      await expect(
        db.insert(schema.artifactInstances).values({
          id: `test-prod-${producer}-${randomUUID()}`,
          runId,
          nodeAttemptId,
          nodeId: "impl",
          attempt: 1,
          kind: "log",
          producer,
          locator: { kind: "inline", text: "test" },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("accepts all valid validity values", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const validities = [
      "current",
      "stale",
      "superseded",
      "failed",
      "skipped",
    ] as const;

    for (const validity of validities) {
      await expect(
        db.insert(schema.artifactInstances).values({
          id: `test-val-${validity}-${randomUUID()}`,
          runId,
          nodeAttemptId,
          nodeId: "impl",
          attempt: 1,
          kind: "log",
          producer: "runner",
          locator: { kind: "inline", text: "test" },
          validity,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("cascades delete when run is deleted", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const id = `cascade-test-${randomUUID()}`;

    await db.insert(schema.artifactInstances).values({
      id,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "log",
      producer: "runner",
      locator: { kind: "inline", text: "test" },
    });

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);

    const rows = await db.execute(
      sql`SELECT id FROM artifact_instances WHERE id = ${id}`,
    );

    expect(rows.rows).toHaveLength(0);
  });

  it("cascades delete when node_attempt is deleted", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const id = `na-cascade-${randomUUID()}`;

    await db.insert(schema.artifactInstances).values({
      id,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff",
      producer: "runner",
      locator: { kind: "git-range", baseCommit: "abc", headRef: "HEAD" },
    });

    await db.execute(
      sql`DELETE FROM node_attempts WHERE id = ${nodeAttemptId}`,
    );

    const rows = await db.execute(
      sql`SELECT id FROM artifact_instances WHERE id = ${id}`,
    );

    expect(rows.rows).toHaveLength(0);
  });

  it("sets superseded_by_id to NULL (not cascade-delete) when referenced artifact is deleted", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const originalId = `orig-${randomUUID()}`;
    const newId = `new-${randomUUID()}`;

    await db.insert(schema.artifactInstances).values({
      id: originalId,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff",
      producer: "runner",
      locator: { kind: "inline", text: "original" },
      validity: "superseded",
    });

    await db.insert(schema.artifactInstances).values({
      id: newId,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff",
      producer: "runner",
      locator: { kind: "inline", text: "new" },
      validity: "current",
      supersededById: originalId,
    });

    await db.execute(
      sql`DELETE FROM artifact_instances WHERE id = ${originalId}`,
    );

    const row = await db.execute(
      sql`SELECT superseded_by_id FROM artifact_instances WHERE id = ${newId}`,
    );

    expect(
      (row.rows[0] as { superseded_by_id: string | null }).superseded_by_id,
    ).toBeNull();
  });

  it("has the expected indexes", async () => {
    const result = await db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'artifact_instances'
      ORDER BY indexname
    `);

    const names = (result.rows as Array<{ indexname: string }>).map(
      (r) => r.indexname,
    );

    // Primary key
    expect(names).toContain("artifact_instances_pkey");
    // 4 explicit indexes
    expect(names.some((n) => n.includes("run_idx"))).toBe(true);
    expect(names.some((n) => n.includes("node_attempt_idx"))).toBe(true);
    expect(names.some((n) => n.includes("run_kind"))).toBe(true);
    expect(names.some((n) => n.includes("run_validity"))).toBe(true);
  });

  it("stores a discriminated locator jsonb correctly", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const id = `locator-test-${randomUUID()}`;
    const locator = {
      kind: "git-range" as const,
      baseCommit: "deadbeef",
      headRef: "feature/test",
    };

    await db.insert(schema.artifactInstances).values({
      id,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff",
      producer: "runner",
      locator,
    });

    const row = await db.execute(
      sql`SELECT locator FROM artifact_instances WHERE id = ${id}`,
    );

    expect((row.rows[0] as { locator: typeof locator }).locator).toEqual(
      locator,
    );
  });

  it("stores required_for jsonb array correctly", async () => {
    const { runId, nodeAttemptId } = await seedChain();
    const id = `req-for-${randomUUID()}`;

    await db.insert(schema.artifactInstances).values({
      id,
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff",
      producer: "runner",
      locator: { kind: "inline", text: "x" },
      requiredFor: ["review", "merge"],
    });

    const row = await db.execute(
      sql`SELECT required_for FROM artifact_instances WHERE id = ${id}`,
    );

    expect((row.rows[0] as { required_for: string[] }).required_for).toEqual([
      "review",
      "merge",
    ]);
  });
});

describe("artifact_projection_cursors table", () => {
  it("exists and has the expected columns", async () => {
    const result = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'artifact_projection_cursors'
      ORDER BY ordinal_position
    `);

    const cols = (result.rows as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );

    expect(cols).toContain("id");
    expect(cols).toContain("run_id");
    expect(cols).toContain("scope");
    expect(cols).toContain("events_log_path");
    expect(cols).toContain("last_monotonic_id");
    expect(cols).toContain("status");
    expect(cols).toContain("updated_at");
  });

  it("accepts all valid status values", async () => {
    const { runId } = await seedChain();
    const statuses = ["idle", "running", "caught_up", "failed"] as const;

    for (const status of statuses) {
      await expect(
        db.insert(schema.artifactProjectionCursors).values({
          id: `cursor-${status}-${randomUUID()}`,
          runId,
          scope: `step-${status}`,
          eventsLogPath: `/tmp/run/${runId}/run.events.jsonl`,
          status,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("enforces unique (run_id, scope) constraint", async () => {
    const { runId } = await seedChain();

    await db.insert(schema.artifactProjectionCursors).values({
      id: `dup-1-${randomUUID()}`,
      runId,
      scope: "same-scope",
      eventsLogPath: "/tmp/events.jsonl",
    });

    await expect(
      db.insert(schema.artifactProjectionCursors).values({
        id: `dup-2-${randomUUID()}`,
        runId,
        scope: "same-scope",
        eventsLogPath: "/tmp/events2.jsonl",
      }),
    ).rejects.toThrow();
  });

  it("cascades delete when run is deleted", async () => {
    const { runId } = await seedChain();
    const cursorId = `cursor-cascade-${randomUUID()}`;

    await db.insert(schema.artifactProjectionCursors).values({
      id: cursorId,
      runId,
      scope: "step-1",
      eventsLogPath: `/tmp/run/${runId}/run.events.jsonl`,
    });

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);

    const rows = await db.execute(
      sql`SELECT id FROM artifact_projection_cursors WHERE id = ${cursorId}`,
    );

    expect(rows.rows).toHaveLength(0);
  });

  it("defaults last_monotonic_id to 0 and status to idle", async () => {
    const { runId } = await seedChain();
    const cursorId = `defaults-${randomUUID()}`;

    await db.insert(schema.artifactProjectionCursors).values({
      id: cursorId,
      runId,
      scope: "step-defaults",
      eventsLogPath: "/tmp/events.jsonl",
    });

    const row = await db.execute(
      sql`SELECT last_monotonic_id, status FROM artifact_projection_cursors WHERE id = ${cursorId}`,
    );

    const r = row.rows[0] as {
      last_monotonic_id: number;
      status: string;
    };

    expect(r.last_monotonic_id).toBe(0);
    expect(r.status).toBe("idle");
  });
});
