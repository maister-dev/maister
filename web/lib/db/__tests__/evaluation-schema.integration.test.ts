import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches webhooks-schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_schema_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seed(): Promise<{
  projectId: string;
  taskId: string;
  runId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
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
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
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
    flowVersion: "v1.0.0",
  });

  return { projectId, taskId, runId };
}

async function insertStudy(
  projectId: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id,
    projectId,
    taskId,
    title: "Study",
    ...overrides,
  });

  return id;
}

describe("evaluation_studies", () => {
  it("inserts an open study and defaults status to draft", async () => {
    const { projectId, taskId } = await seed();
    const id = await insertStudy(projectId, taskId);
    const rows = await db.execute(
      sql`SELECT status, version FROM evaluation_studies WHERE id = ${id}`,
    );

    expect((rows.rows[0] as { status: string }).status).toBe("draft");
    expect((rows.rows[0] as { version: number }).version).toBe(1);
  });

  it("rejects an out-of-domain status via the check constraint", async () => {
    const { projectId, taskId } = await seed();

    await expect(
      insertStudy(projectId, taskId, { status: "evaluating" }),
    ).rejects.toThrow();
  });

  it("enforces legacy_experiment_id UNIQUE but allows many NULLs", async () => {
    const { projectId, taskId } = await seed();

    await insertStudy(projectId, taskId); // NULL legacy id
    await insertStudy(projectId, taskId); // second NULL is fine
    await insertStudy(projectId, taskId, { legacyExperimentId: "exp-1" });
    await expect(
      insertStudy(projectId, taskId, { legacyExperimentId: "exp-1" }),
    ).rejects.toThrow();
  });

  it("RESTRICTs deleting a task while a Study references it", async () => {
    const { projectId, taskId } = await seed();

    await insertStudy(projectId, taskId);
    await expect(
      db.execute(sql`DELETE FROM tasks WHERE id = ${taskId}`),
    ).rejects.toThrow();
  });
});

describe("evaluation_participants", () => {
  it("accepts an observed participant and keeps identity after Run deletion", async () => {
    const { projectId, taskId, runId } = await seed();
    const studyId = await insertStudy(projectId, taskId);
    const partId = randomUUID();

    await db.insert(schema.evaluationParticipants).values({
      id: partId,
      studyId,
      runId,
      sourceType: "observed",
      label: "A",
      runIdentity: { runId, taskId, capturedAt: new Date().toISOString() },
    });

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);
    const rows = await db.execute(
      sql`SELECT run_id, run_identity FROM evaluation_participants WHERE id = ${partId}`,
    );

    // SET NULL: live link gone, copied identity survives.
    expect((rows.rows[0] as { run_id: string | null }).run_id).toBeNull();
    expect(
      (rows.rows[0] as { run_identity: unknown }).run_identity,
    ).toBeTruthy();
  });

  it("rejects an observed participant that carries a recipe lineage", async () => {
    const { projectId, taskId, runId } = await seed();
    const studyId = await insertStudy(projectId, taskId);
    const recipeId = randomUUID();

    await db.insert(schema.evaluationRecipes).values({
      id: recipeId,
      studyId,
      key: "legacy-a",
      label: "A",
      definition: {},
      definitionDigest: "d",
    });

    await expect(
      db.insert(schema.evaluationParticipants).values({
        id: randomUUID(),
        studyId,
        runId,
        sourceType: "observed",
        recipeId,
        label: "A",
      }),
    ).rejects.toThrow();
  });

  it("allows re-adding a Run after its participant is tombstoned (partial UNIQUE)", async () => {
    const { projectId, taskId, runId } = await seed();
    const studyId = await insertStudy(projectId, taskId);

    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId,
      sourceType: "observed",
      label: "A",
    });

    // A second LIVE participant for the same (study, run) violates the partial
    // unique index.
    await expect(
      db.insert(schema.evaluationParticipants).values({
        id: randomUUID(),
        studyId,
        runId,
        sourceType: "observed",
        label: "A2",
      }),
    ).rejects.toThrow();

    // Tombstone the first, then re-add: allowed.
    await db.execute(
      sql`UPDATE evaluation_participants SET removed_at = now() WHERE study_id = ${studyId} AND run_id = ${runId}`,
    );
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId,
      sourceType: "observed",
      label: "A3",
    });

    const count = await db.execute(
      sql`SELECT count(*)::int AS n FROM evaluation_participants WHERE study_id = ${studyId} AND run_id = ${runId}`,
    );

    expect((count.rows[0] as { n: number }).n).toBe(2);
  });
});
