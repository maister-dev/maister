import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  tasks,
  flows,
  flowRevisions,
  evaluationLaunchBatchItems,
} from "@/lib/db/schema";
import { runtimeRoot } from "@/lib/runtime-root";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { createStudy } from "@/lib/evaluations/studies";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { runEvaluationDispatchTick } from "@/lib/evaluations/dispatcher/tick";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { buildFlowContractProjection } from "@/lib/evaluations/preflight-loaders";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
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
let root: string;
let fixture: TaskLaunchFixture;
let seq = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/supervisor-client", async (original) => ({
  ...(await original<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: async () => ({ kind: "available" as const }),
  listSessions: async () => [],
}));
vi.mock("@/lib/flows/runner", () => ({ runFlow: async () => undefined }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "evaluation_task_admission",
  });
  root = await mkdtempReal("evaluation-task-admission-");
  fixture = await seedTaskLaunchFixture(database, root);
  await writeFile(
    path.join(root, "intake.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "environment", type: "string", required: true }],
    }),
  );
  const manifest = {
    schemaVersion: 1,
    name: "Frozen evaluation fixture",
    nodes: [
      {
        id: "intake",
        type: "form",
        settings: { form_schema: "intake.json" },
        transitions: { success: "implement" },
      },
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "Verify the frozen fixture" },
        transitions: { success: "done" },
      },
    ],
  };

  await database.db
    .update(flows)
    .set({ manifest })
    .where(eq(flows.id, fixture.flowId));
  await database.db
    .update(flowRevisions)
    .set({ manifest })
    .where(eq(flowRevisions.flowRefId, fixture.flowId));
  await writeFile(
    path.join(fixture.repo, "README.md"),
    "# Current evaluation fixture\nThe task has a concrete bounded acceptance result.\n",
  );
  await git(fixture.repo, "add", "README.md");
  await git(fixture.repo, "commit", "-m", "Seed evaluation evidence");
  await fakeExecutionHosts(database.db);
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (fixture) {
    const worktrees = await git(
      fixture.repo,
      "worktree",
      "list",
      "--porcelain",
    );

    for (const line of worktrees.split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== fixture.repo)
        await git(fixture.repo, "worktree", "remove", "--force", line.slice(9));
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function controlled() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++seq,
    title: "Evaluate a current task",
    prompt: "Verify the bounded current fixture behavior.",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const study = await createStudy(
    {
      projectId: fixture.projectId,
      taskId,
      title: "Task launch admission",
      createdByUserId: fixture.userId,
    },
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
  const definition: EvaluationControlledRecipeDefinition = {
    schemaVersion: 1,
    flow: {
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.enabledRevisionId!,
      inputContractDigest: computeInputContractDigest(projection),
      artifactContractDigest: computeArtifactContractDigest(projection),
    },
    inputs: {
      taskSnapshotRef: `task:${taskId}`,
      formValues: { environment: "controlled-staging" },
    },
    nodeAgentBindings: [],
    slotBindings: {
      "session:default": { mode: "runner", runnerId: fixture.runnerId },
    },
    executionPolicy: { preset: "supervised" },
    materializationIntent: {
      packagePins: [],
      capabilityRequirements: [],
      allowedProjectOverlays: [],
    },
    promotionHold: { source: "evaluation_study" },
  };
  const recipe = await createControlledRecipe(
    {
      studyId: study.id as string,
      projectId: fixture.projectId,
      key: randomUUID(),
      label: "Controlled variant",
      definition,
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
  const [item] = await database.db
    .select()
    .from(evaluationLaunchBatchItems)
    .where(eq(evaluationLaunchBatchItems.batchId, batch.batchId));

  return {
    taskId,
    batchId: batch.batchId,
    args: {
      studyId: study.id as string,
      projectId: fixture.projectId,
      taskId,
      recipeId: recipe.id as string,
      recipeDefinition: definition,
      replicateOrdinal: 1,
      launchKey: item.id,
      requestedByUserId: fixture.userId,
    },
  };
}
async function qualify(taskId: string): Promise<void> {
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
}
function seam() {
  return defaultLaunchRunSeam({
    actorUserId: fixture.userId,
    authorize: async () => undefined,
  });
}

it("task-bound evaluation refuses an unqualified root before run/workspace/intent effects", async () => {
  const item = await controlled();

  await expect(seam()(item.args)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "qualification_required" },
  });
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE task_id=$1", [
        item.taskId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM task_launch_intents WHERE task_id=$1",
        [item.taskId],
      )
    ).rows,
  ).toEqual([]);
});

it("qualified evaluation accepts a durable automatic intent and leaves its batch pending until a real run is bound", async () => {
  const item = await controlled();

  await qualify(item.taskId);
  const outcome = await runControlledLaunchBatch(
    item.batchId,
    seam(),
    database.db,
  );

  expect(outcome).toMatchObject({ launched: 0, failed: 0 });
  const intents = await database.pool.query(
    "SELECT basis->>'kind' AS basis,settings_snapshot->'serverExecution' AS source,run_id FROM task_launch_intents WHERE task_id=$1",
    [item.taskId],
  );

  expect(intents.rows).toEqual([
    {
      basis: "automatic",
      run_id: null,
      source: expect.objectContaining({
        kind: "evaluation",
        id: item.args.launchKey,
        execution: expect.objectContaining({
          evaluationStudyId: item.args.studyId,
          evaluationBatchItemId: item.args.launchKey,
          evaluationFlowRevisionId:
            item.args.recipeDefinition.flow.flowRevisionId,
        }),
      }),
    },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT status,run_id,participant_id FROM evaluation_launch_batch_items WHERE id=$1",
        [item.args.launchKey],
      )
    ).rows,
  ).toEqual([{ status: "queued", run_id: null, participant_id: null }]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM evaluation_participants WHERE batch_item_id=$1",
        [item.args.launchKey],
      )
    ).rows,
  ).toEqual([]);
});

it("same evaluation item replays its existing intent after a task edit without manufacturing fresh automatic authority", async () => {
  const item = await controlled();

  await qualify(item.taskId);
  await runControlledLaunchBatch(item.batchId, seam(), database.db);
  const accepted = await seam()(item.args);

  expect(accepted).toMatchObject({
    accepted: true,
    intentId: expect.any(String),
  });
  await database.pool.query(
    "UPDATE tasks SET prompt='A later request requiring a separate decision' WHERE id=$1",
    [item.taskId],
  );
  await expect(seam()(item.args)).resolves.toEqual(accepted);
  if (!("intentId" in accepted))
    throw new Error("Expected pending fixture intent");
  await prepareTaskLaunchIntent(database.db, accepted.intentId);
  await expect(seam()(item.args)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "evaluation_launch_held" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int n FROM task_launch_intents WHERE task_id=$1",
        [item.taskId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("existing dispatcher reconciliation creates no participant before binding and adopts the actual run exactly once", async () => {
  const item = await controlled();

  await qualify(item.taskId);
  await runEvaluationDispatchTick(undefined, database.db);
  await runEvaluationDispatchTick(undefined, database.db);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM evaluation_participants WHERE batch_item_id=$1",
        [item.args.launchKey],
      )
    ).rows,
  ).toEqual([]);
  const [intent] = (
    await database.pool.query(
      "SELECT id FROM task_launch_intents WHERE task_id=$1",
      [item.taskId],
    )
  ).rows;

  await prepareTaskLaunchIntent(database.db, intent.id);
  const bound = (
    await database.pool.query(
      'SELECT state,run_id AS "runId" FROM task_launch_intents WHERE id=$1',
      [intent.id],
    )
  ).rows[0];

  expect(bound).toMatchObject({
    state: "run_bound",
    runId: expect.any(String),
  });
  const run = (
    await database.pool.query(
      "SELECT evaluation_batch_item_id,flow_revision_id,promotion_hold,task_admission_snapshot FROM runs WHERE id=$1",
      [bound.runId],
    )
  ).rows[0];

  expect(run).toMatchObject({
    evaluation_batch_item_id: item.args.launchKey,
    flow_revision_id: item.args.recipeDefinition.flow.flowRevisionId,
    promotion_hold: expect.objectContaining({ source: "evaluation_study" }),
    task_admission_snapshot: expect.objectContaining({
      mode: "required",
      intentId: intent.id,
    }),
  });
  expect(
    (
      await database.pool.query(
        "SELECT runner_id FROM run_sessions WHERE run_id=$1",
        [bound.runId],
      )
    ).rows,
  ).toEqual([{ runner_id: fixture.runnerId }]);
  expect(
    JSON.parse(
      await readFile(
        path.join(
          runDirPath(runtimeRoot(), fixture.projectId, bound.runId),
          "input-intake.json",
        ),
        "utf8",
      ),
    ),
  ).toEqual({ environment: "controlled-staging" });
  await runEvaluationDispatchTick(undefined, database.db);
  await runEvaluationDispatchTick(undefined, database.db);
  expect(
    (
      await database.pool.query(
        "SELECT run_id,source_type FROM evaluation_participants WHERE batch_item_id=$1",
        [item.args.launchKey],
      )
    ).rows,
  ).toEqual([{ run_id: bound.runId, source_type: "launched" }]);
  expect(
    (
      await database.pool.query(
        "SELECT status,run_id FROM evaluation_launch_batch_items WHERE id=$1",
        [item.args.launchKey],
      )
    ).rows,
  ).toEqual([{ status: "launched", run_id: bound.runId }]);
});

it("current project authority and frozen recipe are revalidated before replay", async () => {
  const item = await controlled();

  await qualify(item.taskId);
  await runControlledLaunchBatch(item.batchId, seam(), database.db);
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [fixture.userId],
  );
  try {
    await expect(seam()(item.args)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  } finally {
    await database.pool.query(
      "UPDATE users SET account_status='active' WHERE id=$1",
      [fixture.userId],
    );
  }
  await database.pool.query(
    "UPDATE evaluation_recipes SET tombstoned_at=now() WHERE id=$1",
    [item.args.recipeId],
  );
  await expect(seam()(item.args)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "evaluation_launch_source_closed" },
  });
});
