import type { Db } from "@/lib/execution-host/db";
import type { LaunchRunContext } from "@/lib/services/runs";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { tasks, flows, runs, taskLaunchIntents } from "@/lib/db/schema";
import { createStudy } from "@/lib/evaluations/studies";
import { createControlledRecipe } from "@/lib/evaluations/recipes";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
  type ControlledLaunchResult,
  type LaunchRunSeam,
} from "@/lib/evaluations/launch-batch";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { buildFlowContractProjection } from "@/lib/evaluations/preflight-loaders";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";
import { bindAcceptedEngineFixture } from "@/test-support/launch-engine-response";

type EvaluationEngineFixtureSelection = Readonly<{
  taskId: string;
  flowRevisionId?: string;
  formInputs?: Record<string, unknown>;
  sessionRunnerOverrides?: Record<string, string>;
}>;

/** Persist a real controlled recipe and source item, then use its normal preflight/acceptance before technical engine assertions. */
export async function prepareEvaluationEngineFixture(
  db: Db,
  selection: EvaluationEngineFixtureSelection,
  context: LaunchRunContext,
): Promise<
  Readonly<{
    studyId: string;
    recipeId: string;
    batchItemId: string;
    launch: () => Promise<{ runId: string; status: string }>;
  }>
> {
  const [row] = await db
    .select({ task: tasks, flow: flows })
    .from(tasks)
    .innerJoin(
      flows,
      and(eq(flows.id, tasks.flowId), eq(flows.projectId, tasks.projectId)),
    )
    .where(eq(tasks.id, selection.taskId));

  if (!row || !context.actorUserId)
    throw new Error(
      "Evaluation fixture requires a configured task and its persisted authorized actor",
    );
  await context.authorize(row.task.projectId, "launchRun");
  const revisionId = selection.flowRevisionId ?? row.flow.enabledRevisionId;

  if (!revisionId)
    throw new Error("Evaluation fixture requires a real Flow revision");
  const projection = await buildFlowContractProjection(
    {
      projectId: row.task.projectId,
      flowRefId: row.flow.flowRefId,
      flowRevisionId: revisionId,
    },
    db,
  );
  const definition: EvaluationControlledRecipeDefinition = {
    schemaVersion: 1,
    flow: {
      flowRefId: row.flow.flowRefId,
      flowRevisionId: revisionId,
      inputContractDigest: computeInputContractDigest(projection),
      artifactContractDigest: computeArtifactContractDigest(projection),
    },
    inputs: {
      taskSnapshotRef: `task:${row.task.id}`,
      formValues: selection.formInputs ?? {},
    },
    nodeAgentBindings: [],
    slotBindings: Object.fromEntries(
      Object.entries(selection.sessionRunnerOverrides ?? {}).map(
        ([session, runnerId]) => [
          `session:${session}`,
          { mode: "runner" as const, runnerId },
        ],
      ),
    ),
    executionPolicy: { preset: "supervised" },
    materializationIntent: {
      packagePins: [],
      capabilityRequirements: [],
      allowedProjectOverlays: [],
    },
    promotionHold: { source: "evaluation_study" },
  };
  const study = await createStudy(
    {
      projectId: row.task.projectId,
      taskId: row.task.id,
      title: "Technical engine recipe fixture",
      createdByUserId: context.actorUserId,
    },
    db,
  );
  const recipe = await createControlledRecipe(
    {
      studyId: study.id as string,
      projectId: row.task.projectId,
      key: randomUUID(),
      label: "Frozen technical selection",
      definition,
    },
    db,
  );
  const batch = await createControlledLaunchBatch(
    {
      studyId: study.id as string,
      projectId: row.task.projectId,
      requestedByUserId: context.actorUserId,
      items: [{ recipeId: recipe.id as string }],
    },
    db,
  );
  const seam = defaultLaunchRunSeam(context, db);
  const acceptedResults: ControlledLaunchResult[] = [];
  const selections: Parameters<LaunchRunSeam>[0][] = [];
  const failures: unknown[] = [];

  await runControlledLaunchBatch(
    batch.batchId,
    async (args) => {
      try {
        const accepted = await seam(args);

        acceptedResults.push(accepted);
        selections.push(args);

        return accepted;
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    db,
  );
  if (failures.length > 0) throw failures[0];
  const result = acceptedResults[0];

  if (!result || acceptedResults.length !== 1)
    throw new Error(
      "Evaluation fixture did not reach exactly one actual launch seam",
    );

  if ("runId" in result)
    throw new Error(
      "A fresh evaluation fixture unexpectedly reused a bound Run",
    );
  const selectionAtAcceptance = selections[0];

  if (!selectionAtAcceptance)
    throw new Error("Evaluation fixture has no accepted source item");

  return {
    studyId: study.id as string,
    recipeId: recipe.id as string,
    batchItemId: selectionAtAcceptance.launchKey,
    launch: async () => {
      const current = await seam(selectionAtAcceptance);
      let bound: { runId: string; status: string };

      if ("runId" in current) {
        const [run] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, current.runId));

        if (!run) throw new Error("Bound evaluation fixture Run is missing");

        bound = { runId: run.id, status: run.status };
      } else {
        const [intent] = await db
          .select()
          .from(taskLaunchIntents)
          .where(eq(taskLaunchIntents.id, current.intentId));

        if (!intent)
          throw new Error("Evaluation fixture has no durable accepted intent");

        bound = await bindAcceptedEngineFixture(db, taskLaunchReceipt(intent));
      }
      await runControlledLaunchBatch(batch.batchId, seam, db);

      return bound;
    },
  };
}

export async function launchEvaluationEngineFixture(
  db: Db,
  selection: EvaluationEngineFixtureSelection,
  context: LaunchRunContext,
): Promise<{ runId: string; status: string }> {
  return (
    await prepareEvaluationEngineFixture(db, selection, context)
  ).launch();
}
