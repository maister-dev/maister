import type { LaunchRunSeam } from "@/lib/evaluations/launch-batch";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  createControlledLaunchBatch,
  retryFailedBatchItems,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import { createStudy } from "@/lib/evaluations/studies";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let otherProjectId: string;
let flowId: string;
let runnerId: string;
let taskId: string;

async function makeTask(project: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId: project,
    title: "T",
    prompt: "p",
    flowId,
  });

  return id;
}

async function makeRun(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    runKind: "flow",
  });

  return id;
}

function recipeDefinition(count?: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId: "rev-1",
      inputContractDigest: "i",
      artifactContractDigest: "a",
    },
    inputs: { taskSnapshotRef: "snap", formValues: {} },
    executionPolicy: { preset: "supervised" },
    slotBindings: { "session:main": { mode: "runner", runnerId: "r1" } },
    ...(count ? { replicatePolicy: { groupKey: "g1", count } } : {}),
  };
}

async function newRecipe(
  studyId: string,
  key: string,
  count?: number,
): Promise<string> {
  const recipe = await createControlledRecipe(
    {
      studyId,
      projectId,
      key,
      label: `Recipe ${key}`,
      definition: recipeDefinition(count),
    },
    db,
  );

  return recipe.id as string;
}

// A seam that records the launched runs; optionally fails for a given recipe id
// to exercise partial-batch recovery.
function stubSeam(failRecipeId?: string): LaunchRunSeam {
  return async ({ recipeId }) => {
    if (recipeId === failRecipeId) {
      throw new Error("simulated launch failure");
    }

    return { runId: await makeRun() };
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_launch_batch_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  flowId = randomUUID();
  runnerId = randomUUID();

  for (const [pid, slug] of [
    [projectId, "proj"],
    [otherProjectId, "other"],
  ] as const) {
    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: pid,
      slug: `${slug}-${pid.slice(0, 8)}`,
      name: slug,
      repoPath: `/tmp/${slug}-${pid.slice(0, 8)}`,
      maisterYamlPath: "/tmp/m.yaml",
    });
  }
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  taskId = await makeTask(projectId);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("createControlledLaunchBatch", () => {
  it("persists a durable intent with one item per recipe × replicate", async () => {
    const study = await createStudy({ projectId, taskId, title: "B1" }, db);
    const recipeId = await newRecipe(study.id as string, "a", 3);
    const result = await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        items: [{ recipeId }],
      },
      db,
    );

    expect(result.deduped).toBe(false);
    expect(result.itemCount).toBe(3);

    const items = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, result.batchId));

    expect(items).toHaveLength(3);
    expect(
      items.every((i: Record<string, unknown>) => i.status === "queued"),
    ).toBe(true);
    expect(
      items.map((i: Record<string, unknown>) => i.replicateOrdinal).sort(),
    ).toEqual([1, 2, 3]);
  });

  it("dedups a duplicate submit by idempotency key", async () => {
    const study = await createStudy({ projectId, taskId, title: "B2" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const key = randomUUID();
    const first = await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        idempotencyKey: key,
        items: [{ recipeId }],
      },
      db,
    );
    const second = await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        idempotencyKey: key,
        items: [{ recipeId }],
      },
      db,
    );

    expect(second.deduped).toBe(true);
    expect(second.batchId).toBe(first.batchId);
  });

  it("rejects a recipe that does not belong to the study", async () => {
    const study = await createStudy({ projectId, taskId, title: "B3" }, db);
    const otherStudy = await createStudy(
      { projectId, taskId, title: "B3b" },
      db,
    );
    const foreignRecipe = await newRecipe(otherStudy.id as string, "a");

    await expect(
      createControlledLaunchBatch(
        {
          studyId: study.id as string,
          projectId,
          items: [{ recipeId: foreignRecipe }],
        },
        db,
      ),
    ).rejects.toThrow(/not found in study/);
  });
});

describe("runControlledLaunchBatch", () => {
  it("launches all items, creates launched participants, and completes the batch", async () => {
    const study = await createStudy({ projectId, taskId, title: "R1" }, db);
    const recipeId = await newRecipe(study.id as string, "a", 2);
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    const outcome = await runControlledLaunchBatch(batchId, stubSeam(), db);

    expect(outcome).toEqual({ launched: 2, failed: 0, skipped: 0 });

    const [batch] = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.id, batchId));

    expect(batch.status).toBe("completed");

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.studyId, study.id as string));

    expect(participants).toHaveLength(2);
    expect(
      participants.every(
        (p: Record<string, unknown>) => p.sourceType === "launched",
      ),
    ).toBe(true);
    expect(
      participants.every(
        (p: Record<string, unknown>) => p.recipeId === recipeId,
      ),
    ).toBe(true);

    // First launched participant flips the draft study to open.
    const [refreshed] = await db
      .select()
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.id, study.id as string));

    expect(refreshed.status).toBe("open");
  });

  it("records a partial batch when one item fails (per-item state, no lost work)", async () => {
    const study = await createStudy({ projectId, taskId, title: "R2" }, db);
    const good = await newRecipe(study.id as string, "good");
    const bad = await newRecipe(study.id as string, "bad");
    const { batchId } = await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        items: [{ recipeId: good }, { recipeId: bad }],
      },
      db,
    );

    const outcome = await runControlledLaunchBatch(batchId, stubSeam(bad), db);

    expect(outcome.launched).toBe(1);
    expect(outcome.failed).toBe(1);

    const [batch] = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.id, batchId));

    expect(batch.status).toBe("partial");

    const failedItem = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(
        and(
          eq(schema.evaluationLaunchBatchItems.batchId, batchId),
          eq(schema.evaluationLaunchBatchItems.recipeId, bad),
        ),
      );

    expect(failedItem[0].status).toBe("failed");
    expect(failedItem[0].attempt).toBe(1);
    expect(failedItem[0].errorReason).toContain("simulated");
  });

  it("does not re-launch already-launched items on a second drive (crash recovery)", async () => {
    const study = await createStudy({ projectId, taskId, title: "R3" }, db);
    const recipeId = await newRecipe(study.id as string, "a", 2);
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    await runControlledLaunchBatch(batchId, stubSeam(), db);
    // Second drive: all items already launched → nothing queued.
    const second = await runControlledLaunchBatch(batchId, stubSeam(), db);

    expect(second).toEqual({ launched: 0, failed: 0, skipped: 0 });

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.studyId, study.id as string));

    // Still exactly 2 — no duplicate launched participants.
    expect(participants).toHaveLength(2);
  });

  it("retry re-queues failed items and a re-drive launches them", async () => {
    const study = await createStudy({ projectId, taskId, title: "R4" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    // First drive fails the recipe, then retry + a healthy seam succeeds.
    await runControlledLaunchBatch(batchId, stubSeam(recipeId), db);
    const { requeued } = await retryFailedBatchItems(batchId, 3, db);

    expect(requeued).toBe(1);

    const outcome = await runControlledLaunchBatch(batchId, stubSeam(), db);

    expect(outcome.launched).toBe(1);

    const [batch] = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.id, batchId));

    expect(batch.status).toBe("completed");
  });
});
