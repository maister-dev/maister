import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flows,
  tasks,
  runs,
  evaluationLaunchBatchItems,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { createStudy } from "@/lib/evaluations/studies";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import { buildFlowContractProjection } from "@/lib/evaluations/preflight-loaders";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
  database = await startMainPostgresTestDb({
    databaseName: "evaluation_launch_capacity",
  });
  root = await mkdtempReal("evaluation-launch-capacity-");
  fixture = await seedTaskLaunchFixture(database, root);
  await writeFile(
    path.join(fixture.repo, "README.md"),
    "# Owned evaluation capacity fixture\n",
  );
  await git(fixture.repo, "add", "README.md");
  await git(fixture.repo, "commit", "-m", "Seed capacity evidence");
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("full global capacity preserves a qualified evaluation intent without fabricating a run or participant", async () => {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: 1,
    title: "Evaluate under capacity",
    prompt: "Verify the bounded current fixture.",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const sha = await git(fixture.repo, "rev-parse", "HEAD");
  const qualification = qualificationFixture();

  qualification.evidenceRefs = [
    { id: "repo", kind: "repository", reference: `git:${sha}:README.md` },
  ];
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification,
      flowId: fixture.flowId,
      runnerId: fixture.runnerId,
      enqueue: false,
    },
  });

  await database.db.transaction((tx: Db) => prepared.apply(tx));
  const study = await createStudy(
    { projectId: fixture.projectId, taskId, title: "Capacity" },
    database.db,
  );
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const projection = await buildFlowContractProjection(
    {
      projectId: fixture.projectId,
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.enabledRevisionId!,
    },
    database.db,
  );
  const recipe = await createControlledRecipe(
    {
      studyId: study.id as string,
      projectId: fixture.projectId,
      key: "capacity",
      label: "Capacity",
      definition: {
        schemaVersion: 1,
        flow: {
          flowRefId: flow.flowRefId,
          flowRevisionId: flow.enabledRevisionId!,
          inputContractDigest: computeInputContractDigest(projection),
          artifactContractDigest: computeArtifactContractDigest(projection),
        },
        inputs: { taskSnapshotRef: `task:${taskId}`, formValues: {} },
        executionPolicy: { preset: "supervised" },
      },
    },
    database.db,
  );
  const batch = await createControlledLaunchBatch(
    {
      studyId: study.id as string,
      projectId: fixture.projectId,
      requestedByUserId: fixture.userId,
      items: [{ recipeId: recipe.id as string }],
    },
    database.db,
  );

  // The isolated test process has exactly one slot and one owned fixture row.
  await database.db.insert(runs).values({
    id: randomUUID(),
    projectId: fixture.projectId,
    flowId: fixture.flowId,
    runKind: "flow",
    status: "Running",
    flowVersion: "v1",
  });
  const outcome = await runControlledLaunchBatch(
    batch.batchId,
    defaultLaunchRunSeam({
      actorUserId: fixture.userId,
      authorize: async () => undefined,
    }),
    database.db,
  );

  expect(outcome).toEqual({ launched: 0, failed: 0, skipped: 0 });
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, taskId));

  expect(await prepareTaskLaunchIntent(database.db, intent.id)).toMatchObject({
    state: "queued",
    runId: null,
  });
  const [item] = await database.db
    .select()
    .from(evaluationLaunchBatchItems)
    .where(eq(evaluationLaunchBatchItems.batchId, batch.batchId));

  expect(item).toMatchObject({
    status: "queued",
    runId: null,
    participantId: null,
    errorReason: null,
  });
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE task_id=$1", [
        taskId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM evaluation_participants WHERE batch_item_id=$1",
        [item.id],
      )
    ).rows,
  ).toEqual([]);
});
