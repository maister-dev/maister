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
// the type-only clash.
import * as fullSchema from "@/lib/db/schema";
import {
  failArtifact,
  getArtifactsForRun,
  getCurrentArtifact,
  markArtifactsStale,
  recordArtifact,
  recordCurrentArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";

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

async function seedRun(): Promise<{
  runId: string;
  nodeAttemptId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

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
    executorId,
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "impl",
    nodeType: "ai_coding",
    attempt: 1,
  });

  return { runId, nodeAttemptId };
}

describe("recordCurrentArtifact (atomic record + supersede)", () => {
  it("re-recording a def across attempts leaves exactly one current row, prior superseded", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    const attempt2Id = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: attempt2Id,
      runId,
      nodeId: "impl",
      nodeType: "ai_coding",
      attempt: 2,
    });

    const first = await recordCurrentArtifact(
      {
        id: `run:${nodeAttemptId}:impl-diff`,
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "git-range", baseCommit: "abc", headRef: "sha1" },
        artifactDefId: "impl-diff",
        requiredFor: ["review"],
      },
      db,
    );

    const second = await recordCurrentArtifact(
      {
        id: `run:${attempt2Id}:impl-diff`,
        runId,
        nodeAttemptId: attempt2Id,
        nodeId: "impl",
        attempt: 2,
        kind: "diff",
        producer: "runner",
        locator: { kind: "git-range", baseCommit: "abc", headRef: "sha2" },
        artifactDefId: "impl-diff",
        requiredFor: ["review"],
      },
      db,
    );

    // Exactly one current row for the def — the dual-current window the
    // non-atomic record+supersede pair could leave on a crash is closed.
    const currentRows = await db.execute(
      sql`SELECT id FROM artifact_instances WHERE run_id = ${runId} AND artifact_def_id = 'impl-diff' AND validity = 'current'`,
    );

    expect(currentRows.rows).toHaveLength(1);
    expect((currentRows.rows[0] as { id: string }).id).toBe(second.id);

    // The prior attempt's row is superseded and points at the new row.
    const prior = await db.execute(
      sql`SELECT validity, superseded_by_id FROM artifact_instances WHERE id = ${first.id}`,
    );

    expect((prior.rows[0] as { validity: string }).validity).toBe("superseded");
    expect(
      (prior.rows[0] as { superseded_by_id: string }).superseded_by_id,
    ).toBe(second.id);

    // getCurrentArtifact returns the latest attempt deterministically.
    const current = await getCurrentArtifact(runId, "impl-diff", db);

    expect(current?.id).toBe(second.id);
  });
});

describe("recordArtifact", () => {
  it("inserts a new artifact and returns its id", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    const result = await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "git-range", baseCommit: "abc", headRef: "HEAD" },
        artifactDefId: "impl-diff",
      },
      db,
    );

    expect(result.id).toBe(`run:${nodeAttemptId}:impl-diff`);
  });

  it("is idempotent: re-recording the same id yields 1 row, not 2", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    const args = {
      runId,
      nodeAttemptId,
      nodeId: "impl",
      attempt: 1,
      kind: "diff" as const,
      producer: "runner" as const,
      locator: {
        kind: "git-range" as const,
        baseCommit: "abc",
        headRef: "HEAD",
      },
      artifactDefId: "impl-diff",
    };

    await recordArtifact(args, db);
    await recordArtifact(args, db);

    const rows = await db.execute(
      sql`SELECT id FROM artifact_instances WHERE run_id = ${runId} AND artifact_def_id = 'impl-diff'`,
    );

    expect(rows.rows).toHaveLength(1);
  });

  it("uses default id when no artifactDefId (kind-based)", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    const result = await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "log",
        producer: "runner",
        locator: { kind: "file", path: "/tmp/run/impl.log" },
      },
      db,
    );

    expect(result.id).toBe(`run:${nodeAttemptId}:default:log`);
  });

  it("accepts a caller-supplied id (projector rows)", async () => {
    const { runId, nodeAttemptId } = await seedRun();
    const projId = `proj:${runId}:42`;

    const result = await recordArtifact(
      {
        id: projId,
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "log",
        producer: "projector",
        locator: { kind: "inline", text: "tool call log" },
      },
      db,
    );

    expect(result.id).toBe(projId);
  });
});

describe("supersedePrior", () => {
  it("sets prior current artifact to superseded and sets superseded_by_id", async () => {
    const { runId, nodeAttemptId } = await seedRun();
    // Seed a second node_attempt for the second artifact row
    const secondNodeAttemptId = randomUUID();

    await db.execute(
      sql`INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt) VALUES (${secondNodeAttemptId}, ${runId}, 'impl', 'ai_coding', 2)`,
    );

    const firstId = `run:${nodeAttemptId}:impl-diff`;
    const secondId = `run:${secondNodeAttemptId}:impl-diff`;

    await recordArtifact(
      {
        id: firstId,
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "first" },
        artifactDefId: "impl-diff",
      },
      db,
    );

    // Second artifact must exist before superseded_by_id FK can point to it
    await recordArtifact(
      {
        id: secondId,
        runId,
        nodeAttemptId: secondNodeAttemptId,
        nodeId: "impl",
        attempt: 2,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "second" },
        artifactDefId: "impl-diff",
      },
      db,
    );

    await supersedePrior(runId, "impl", "impl-diff", secondId, db);

    const row = await db.execute(
      sql`SELECT validity, superseded_by_id FROM artifact_instances WHERE id = ${firstId}`,
    );

    const r = row.rows[0] as {
      validity: string;
      superseded_by_id: string;
    };

    expect(r.validity).toBe("superseded");
    expect(r.superseded_by_id).toBe(secondId);
  });

  it("retires ALL prior rows of the def, including stale ones (PR1/F2)", async () => {
    const { runId, nodeAttemptId } = await seedRun();
    const staleId = `run:${nodeAttemptId}:stale-def`;
    const freshId = `run:${nodeAttemptId}:stale-def-fresh`;

    // A stale orphan row of the def (e.g. left behind by a rework markStale).
    await recordArtifact(
      {
        id: staleId,
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "stale-def",
        validity: "stale",
      },
      db,
    );

    // Re-produce a fresh current row for the same def, then supersede prior.
    await recordArtifact(
      {
        id: freshId,
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 2,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "v2" },
        artifactDefId: "stale-def",
        validity: "current",
      },
      db,
    );

    await supersedePrior(runId, "impl", "stale-def", freshId, db);

    const row = await db.execute(
      sql`SELECT validity, superseded_by_id FROM artifact_instances WHERE id = ${staleId}`,
    );
    const r = row.rows[0] as {
      validity: string;
      superseded_by_id: string;
    };

    // The stale orphan is retired to superseded (not left stale forever).
    expect(r.validity).toBe("superseded");
    expect(r.superseded_by_id).toBe(freshId);
  });
});

describe("markArtifactsStale", () => {
  it("sets current artifacts for given nodeIds to stale", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "impl-diff",
      },
      db,
    );

    await markArtifactsStale(runId, ["impl"], db);

    const rows = await db.execute(
      sql`SELECT validity FROM artifact_instances WHERE run_id = ${runId} AND node_id = 'impl'`,
    );

    for (const row of rows.rows) {
      expect((row as { validity: string }).validity).toBe("stale");
    }
  });

  it("does not stale artifacts for nodeIds not in the list", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "impl-diff",
      },
      db,
    );

    await markArtifactsStale(runId, ["other-node"], db);

    const rows = await db.execute(
      sql`SELECT validity FROM artifact_instances WHERE run_id = ${runId} AND node_id = 'impl'`,
    );

    for (const row of rows.rows) {
      expect((row as { validity: string }).validity).toBe("current");
    }
  });

  it("ignores already-stale or superseded artifacts (no error)", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "already-stale",
        validity: "stale",
      },
      db,
    );

    await expect(
      markArtifactsStale(runId, ["impl"], db),
    ).resolves.not.toThrow();
  });
});

describe("getArtifactsForRun", () => {
  it("returns all artifact rows for the run", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "a" },
        artifactDefId: "diff-a",
      },
      db,
    );

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "log",
        producer: "runner",
        locator: { kind: "inline", text: "b" },
        artifactDefId: "log-b",
      },
      db,
    );

    const rows = await getArtifactsForRun(runId, db);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.runId).every((rid) => rid === runId)).toBe(true);
  });
});

describe("getCurrentArtifact", () => {
  it("returns the current artifact for (runId, artifactDefId)", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "target-def",
      },
      db,
    );

    const result = await getCurrentArtifact(runId, "target-def", db);

    expect(result).toBeDefined();
    expect(result!.artifactDefId).toBe("target-def");
    expect(result!.validity).toBe("current");
  });

  it("returns undefined when no current artifact exists", async () => {
    const { runId } = await seedRun();

    const result = await getCurrentArtifact(runId, "non-existent-def", db);

    expect(result).toBeUndefined();
  });

  it("ignores non-current (stale/superseded) artifacts", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "stale-def",
        validity: "stale",
      },
      db,
    );

    const result = await getCurrentArtifact(runId, "stale-def", db);

    expect(result).toBeUndefined();
  });
});

describe("failArtifact", () => {
  it("sets validity to failed", async () => {
    const { runId, nodeAttemptId } = await seedRun();

    const { id } = await recordArtifact(
      {
        runId,
        nodeAttemptId,
        nodeId: "impl",
        attempt: 1,
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        artifactDefId: "fail-me",
      },
      db,
    );

    await failArtifact(id, db);

    const row = await db.execute(
      sql`SELECT validity FROM artifact_instances WHERE id = ${id}`,
    );

    expect((row.rows[0] as { validity: string }).validity).toBe("failed");
  });
});
