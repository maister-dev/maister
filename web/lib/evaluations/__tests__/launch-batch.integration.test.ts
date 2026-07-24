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
import { MaisterError } from "@/lib/errors";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import { createStudy } from "@/lib/evaluations/studies";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
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

  it("rejects the same key reused for a different launch request (digest mismatch)", async () => {
    const study = await createStudy({ projectId, taskId, title: "B4" }, db);
    const recipeA = await newRecipe(study.id as string, "a");
    const recipeB = await newRecipe(study.id as string, "b");
    const key = randomUUID();

    await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        idempotencyKey: key,
        items: [{ recipeId: recipeA }],
      },
      db,
    );

    await expect(
      createControlledLaunchBatch(
        {
          studyId: study.id as string,
          projectId,
          idempotencyKey: key,
          items: [{ recipeId: recipeB }],
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(
        /already used for a different launch request/,
      ),
    });
  });

  it("scopes the idempotency key to the study (no cross-study dedup)", async () => {
    const studyA = await createStudy({ projectId, taskId, title: "B5a" }, db);
    const studyB = await createStudy({ projectId, taskId, title: "B5b" }, db);
    const recipeA = await newRecipe(studyA.id as string, "a");
    const recipeB = await newRecipe(studyB.id as string, "a");
    const key = randomUUID();

    const first = await createControlledLaunchBatch(
      {
        studyId: studyA.id as string,
        projectId,
        idempotencyKey: key,
        items: [{ recipeId: recipeA }],
      },
      db,
    );
    const second = await createControlledLaunchBatch(
      {
        studyId: studyB.id as string,
        projectId,
        idempotencyKey: key,
        items: [{ recipeId: recipeB }],
      },
      db,
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(second.batchId).not.toBe(first.batchId);
  });

  it("converges two concurrent same-key first submits on one batch (no raw 23505)", async () => {
    const study = await createStudy({ projectId, taskId, title: "B6" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const key = randomUUID();
    const args = {
      studyId: study.id as string,
      projectId,
      idempotencyKey: key,
      items: [{ recipeId }],
    };

    const settled = await Promise.allSettled([
      createControlledLaunchBatch(args, db),
      createControlledLaunchBatch(args, db),
    ]);
    const rejections = settled.filter((s) => s.status === "rejected");

    // Never a raw unique-violation leak — both racers converge or replay.
    expect(
      rejections.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);

    const results = settled.flatMap((s) =>
      s.status === "fulfilled" ? [s.value] : [],
    );

    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.batchId)).size).toBe(1);
    expect(results.map((r) => r.deduped).sort()).toEqual([false, true]);

    const batches = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.studyId, study.id as string));

    expect(batches).toHaveLength(1);
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
    // The persisted reason is a typed marker, never the raw error message
    // (which may embed host paths).
    expect(failedItem[0].errorReason).toBe("CRASH");
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

  it("adopts a launching item whose participant already exists (crash window) without re-invoking the seam", async () => {
    const study = await createStudy({ projectId, taskId, title: "R5" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );
    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    // Mimic a drive that died AFTER its participant transaction committed but
    // never finalized the item: item stuck in `launching`, participant durable.
    await db
      .update(schema.evaluationLaunchBatchItems)
      .set({ status: "launching" })
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    const orphanRunId = await makeRun();
    const participantId = randomUUID();

    await db.insert(schema.evaluationParticipants).values({
      id: participantId,
      studyId: study.id as string,
      runId: orphanRunId,
      sourceType: "launched",
      recipeId,
      batchItemId: item.id,
      label: "Recipe a #1",
      replicateGroup: "a",
      replicateOrdinal: 1,
      launchReason: "initial",
    });

    const seamCalls: string[] = [];
    const seam: LaunchRunSeam = async ({ launchKey }) => {
      seamCalls.push(launchKey);

      return { runId: await makeRun() };
    };

    const outcome = await runControlledLaunchBatch(batchId, seam, db);

    expect(outcome).toEqual({ launched: 0, failed: 0, skipped: 0 });
    expect(seamCalls).toEqual([]);

    const [adopted] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    expect(adopted.status).toBe("launched");
    expect(adopted.participantId).toBe(participantId);
    expect(adopted.runId).toBe(orphanRunId);

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.batchItemId, item.id));

    expect(participants).toHaveLength(1);

    const [batch] = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.id, batchId));

    expect(batch.status).toBe("completed");
  });

  it("re-queues a stuck launching item with no participant and re-drives it in the same pass", async () => {
    const study = await createStudy({ projectId, taskId, title: "R6" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );
    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    // Mimic a drive that died between the claim and any participant write.
    await db
      .update(schema.evaluationLaunchBatchItems)
      .set({ status: "launching" })
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    const seamCalls: string[] = [];
    const seam: LaunchRunSeam = async ({ launchKey }) => {
      seamCalls.push(launchKey);

      return { runId: await makeRun() };
    };

    const outcome = await runControlledLaunchBatch(batchId, seam, db);

    expect(outcome).toEqual({ launched: 1, failed: 0, skipped: 0 });
    // The seam's dedup handle is the item id, stable across retries.
    expect(seamCalls).toEqual([item.id]);

    const [launchedItem] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    expect(launchedItem.status).toBe("launched");

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.batchItemId, item.id));

    expect(participants).toHaveLength(1);
  });

  it("converges a re-driven item onto its existing participant (seam idempotency, re-adoption)", async () => {
    const study = await createStudy({ projectId, taskId, title: "R7" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    // Seam honoring the launchKey contract: the same key always returns the
    // same run, never a second one.
    const runByKey = new Map<string, string>();
    const seamCalls: string[] = [];
    const seam: LaunchRunSeam = async ({ launchKey }) => {
      seamCalls.push(launchKey);
      let runId = runByKey.get(launchKey);

      if (!runId) {
        runId = await makeRun();
        runByKey.set(launchKey, runId);
      }

      return { runId };
    };

    await runControlledLaunchBatch(batchId, seam, db);

    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(item.status).toBe("launched");
    const originalParticipantId = item.participantId;
    const originalRunId = item.runId;

    // Mimic lost item bookkeeping: back to `launching`, ids cleared on the
    // ITEM only — the participant row stays durable.
    await db
      .update(schema.evaluationLaunchBatchItems)
      .set({ status: "launching", participantId: null, runId: null })
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    const outcome = await runControlledLaunchBatch(batchId, seam, db);

    expect(outcome).toEqual({ launched: 0, failed: 0, skipped: 0 });
    // Adopted via the durable participant — the seam is never re-invoked.
    expect(seamCalls).toEqual([item.id]);

    const [readopted] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.id, item.id));

    expect(readopted.status).toBe("launched");
    expect(readopted.participantId).toBe(originalParticipantId);
    expect(readopted.runId).toBe(originalRunId);

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.batchItemId, item.id));

    expect(participants).toHaveLength(1);
  });
});

describe("launch-time governance gates (kill switch / study status / tombstone)", () => {
  const KILL_SWITCH_ENV = "MAISTER_CONTROLLED_RECIPES_ENABLED";

  function trackingSeam(calls: string[]): LaunchRunSeam {
    return async ({ launchKey }) => {
      calls.push(launchKey);

      return { runId: await makeRun() };
    };
  }

  async function withKillSwitchOff<T>(fn: () => Promise<T>): Promise<T> {
    const prior = process.env[KILL_SWITCH_ENV];

    process.env[KILL_SWITCH_ENV] = "false";
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env[KILL_SWITCH_ENV];
      else process.env[KILL_SWITCH_ENV] = prior;
    }
  }

  it("halts the drive under the kill switch, leaving items queued, then drains after re-enable", async () => {
    const study = await createStudy({ projectId, taskId, title: "G1" }, db);
    const recipeId = await newRecipe(study.id as string, "a", 2);
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );
    const seamCalls: string[] = [];

    const halted = await withKillSwitchOff(() =>
      runControlledLaunchBatch(batchId, trackingSeam(seamCalls), db),
    );

    expect(halted).toEqual({ launched: 0, failed: 0, skipped: 0 });
    expect(seamCalls).toEqual([]);

    const items = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(
      items.every((i: Record<string, unknown>) => i.status === "queued"),
    ).toBe(true);

    // Freeze lifted → the SAME durable batch drains normally.
    const drained = await runControlledLaunchBatch(
      batchId,
      trackingSeam(seamCalls),
      db,
    );

    expect(drained).toEqual({ launched: 2, failed: 0, skipped: 0 });
  });

  it("terminalizes queued items with a typed reason when the study is no longer launchable", async () => {
    const study = await createStudy({ projectId, taskId, title: "G2" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    await db
      .update(schema.evaluationStudies)
      .set({ status: "decided" })
      .where(eq(schema.evaluationStudies.id, study.id as string));

    const seamCalls: string[] = [];
    const outcome = await runControlledLaunchBatch(
      batchId,
      trackingSeam(seamCalls),
      db,
    );

    expect(outcome).toEqual({ launched: 0, failed: 1, skipped: 0 });
    expect(seamCalls).toEqual([]);

    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(item.status).toBe("failed");
    expect(item.errorReason).toBe("STUDY_NOT_LAUNCHABLE");

    const [batch] = await db
      .select()
      .from(schema.evaluationLaunchBatches)
      .where(eq(schema.evaluationLaunchBatches.id, batchId));

    expect(batch.status).toBe("failed");
  });

  it("terminalizes queued items whose recipe was tombstoned after batch create", async () => {
    const study = await createStudy({ projectId, taskId, title: "G3" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    await db
      .update(schema.evaluationRecipes)
      .set({ tombstonedAt: new Date() })
      .where(eq(schema.evaluationRecipes.id, recipeId));

    const seamCalls: string[] = [];
    const outcome = await runControlledLaunchBatch(
      batchId,
      trackingSeam(seamCalls),
      db,
    );

    expect(outcome).toEqual({ launched: 0, failed: 1, skipped: 0 });
    expect(seamCalls).toEqual([]);

    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(item.errorReason).toBe("RECIPE_TOMBSTONED");
  });

  it("retry refuses under the kill switch and skips tombstoned recipes", async () => {
    const study = await createStudy({ projectId, taskId, title: "G4" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    // Fail the item once via a failing seam.
    await runControlledLaunchBatch(batchId, stubSeam(recipeId), db);

    const frozen = await withKillSwitchOff(() =>
      retryFailedBatchItems(batchId, 5, db),
    );

    expect(frozen).toEqual({ requeued: 0 });

    await db
      .update(schema.evaluationRecipes)
      .set({ tombstonedAt: new Date() })
      .where(eq(schema.evaluationRecipes.id, recipeId));

    expect(await retryFailedBatchItems(batchId, 5, db)).toEqual({
      requeued: 0,
    });

    await db
      .update(schema.evaluationRecipes)
      .set({ tombstonedAt: null })
      .where(eq(schema.evaluationRecipes.id, recipeId));

    expect(await retryFailedBatchItems(batchId, 5, db)).toEqual({
      requeued: 1,
    });
  });

  it("retry refuses when the study is no longer launchable", async () => {
    const study = await createStudy({ projectId, taskId, title: "G5" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    await runControlledLaunchBatch(batchId, stubSeam(recipeId), db);
    await db
      .update(schema.evaluationStudies)
      .set({ status: "archived" })
      .where(eq(schema.evaluationStudies.id, study.id as string));

    expect(await retryFailedBatchItems(batchId, 5, db)).toEqual({
      requeued: 0,
    });
  });

  it("persists the MaisterError code as the item error reason (never raw text)", async () => {
    const study = await createStudy({ projectId, taskId, title: "G6" }, db);
    const recipeId = await newRecipe(study.id as string, "a");
    const { batchId } = await createControlledLaunchBatch(
      { studyId: study.id as string, projectId, items: [{ recipeId }] },
      db,
    );

    const typedFailingSeam: LaunchRunSeam = async () => {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "runner down at /Users/someone/private/repo",
      );
    };

    const outcome = await runControlledLaunchBatch(
      batchId,
      typedFailingSeam,
      db,
    );

    expect(outcome.failed).toBe(1);

    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(item.errorReason).toBe("EXECUTOR_UNAVAILABLE");
    expect(item.errorReason).not.toContain("/Users/");
  });

  // ADR-150 (adversarial fix B2): a study that becomes `decided` DURING the seam
  // call must not acquire a launched participant. The seam here flips the study
  // mid-launch; the in-tx re-check refuses, so no participant is written and the
  // item lands `failed` rather than resurrecting into a decided study.
  it("refuses to write a participant when the study is decided during the seam call", async () => {
    const study = await createStudy(
      { projectId, taskId, title: "SeamWindow" },
      db,
    );
    const studyId = study.id as string;
    const recipeId = await newRecipe(studyId, "sw", 1);
    const { batchId } = await createControlledLaunchBatch(
      { studyId, projectId, items: [{ recipeId }] },
      db,
    );

    const decidingSeam: LaunchRunSeam = async () => {
      // Simulate the study concluding while this launch is in flight.
      await db
        .update(schema.evaluationStudies)
        .set({ status: "decided" })
        .where(eq(schema.evaluationStudies.id, studyId));

      return { runId: await makeRun() };
    };

    const outcome = await runControlledLaunchBatch(batchId, decidingSeam, db);

    expect(outcome.launched).toBe(0);
    expect(outcome.failed).toBe(1);

    const participants = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.studyId, studyId));

    expect(participants).toHaveLength(0);
  });
});
