import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchRunSeam } from "./launch-batch";
import type { EvaluationControlledRecipeDefinition } from "./recipe-schema";
import type {
  TaskLaunchEngineExtras,
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { and, eq } from "drizzle-orm";

import { contentDigest } from "./digest";
import { controlledRecipesEnabled } from "./launch-batch";
import { parseControlledRecipe } from "./recipe";
import { isSeamThreadableSlot } from "./slot-threading";

import {
  evaluationLaunchBatches,
  evaluationLaunchBatchItems,
  evaluationRecipes,
  evaluationStudies,
  tasks,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

type LaunchSelection = Parameters<LaunchRunSeam>[0];

async function loadEvaluationLaunchFacts(db: Db, itemId: string) {
  const [row] = await db
    .select({
      item: evaluationLaunchBatchItems,
      batch: evaluationLaunchBatches,
      study: evaluationStudies,
      recipe: evaluationRecipes,
    })
    .from(evaluationLaunchBatchItems)
    .innerJoin(
      evaluationLaunchBatches,
      eq(evaluationLaunchBatches.id, evaluationLaunchBatchItems.batchId),
    )
    .innerJoin(
      evaluationStudies,
      eq(evaluationStudies.id, evaluationLaunchBatches.studyId),
    )
    .innerJoin(
      evaluationRecipes,
      and(
        eq(evaluationRecipes.id, evaluationLaunchBatchItems.recipeId),
        eq(evaluationRecipes.studyId, evaluationStudies.id),
      ),
    )
    .innerJoin(
      tasks,
      and(
        eq(tasks.id, evaluationStudies.taskId),
        eq(tasks.projectId, evaluationStudies.projectId),
      ),
    )
    .where(eq(evaluationLaunchBatchItems.id, itemId));

  if (!row) throw evaluationSourceRefusal("evaluation_launch_source_missing");

  return row;
}
type EvaluationLaunchFacts = Awaited<
  ReturnType<typeof loadEvaluationLaunchFacts>
>;

function evaluationSourceRefusal(reason: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Controlled evaluation launch requires a current authorized source",
    { details: { reason } },
  );
}

function definitionForSource(
  facts: EvaluationLaunchFacts,
): EvaluationControlledRecipeDefinition {
  const definition = parseControlledRecipe(facts.recipe.definition);

  if (contentDigest(definition) !== facts.recipe.definitionDigest)
    throw evaluationSourceRefusal("evaluation_launch_source_changed");

  return definition;
}

function evaluationExecution(
  facts: EvaluationLaunchFacts,
  definition: EvaluationControlledRecipeDefinition,
): TaskLaunchEngineExtras {
  const sessionRunnerOverrides: Record<string, string> = Object.fromEntries(
    Object.entries(definition.slotBindings).flatMap(
      ([slot, target]): Array<[string, string]> =>
        target.mode === "runner" && isSeamThreadableSlot(slot)
          ? [[slot.slice("session:".length), target.runnerId]]
          : [],
    ),
  );

  return {
    allowConcurrent: true,
    evaluationStudyId: facts.study.id,
    evaluationBatchItemId: facts.item.id,
    evaluationFlowRevisionId: definition.flow.flowRevisionId,
    ...(Object.keys(definition.inputs.formValues).length
      ? { evaluationFormInputs: definition.inputs.formValues }
      : {}),
    ...(Object.keys(sessionRunnerOverrides).length
      ? { sessionRunnerOverrides }
      : {}),
  };
}

function snapshotForSource(
  facts: EvaluationLaunchFacts,
): TaskLaunchServerSourceSnapshot {
  const definition = definitionForSource(facts);

  return {
    version: 1,
    kind: "evaluation",
    id: facts.item.id,
    projectId: facts.study.projectId,
    taskId: facts.study.taskId,
    revisionDigest: contentDigest({
      version: 1,
      kind: "evaluation_launch_item",
      itemId: facts.item.id,
      batchId: facts.batch.id,
      studyId: facts.study.id,
      projectId: facts.study.projectId,
      taskId: facts.study.taskId,
      recipeId: facts.recipe.id,
      recipeDigest: facts.recipe.definitionDigest,
      replicateOrdinal: facts.item.replicateOrdinal,
      requestedByUserId: facts.batch.requestedByUserId,
    }),
    execution: evaluationExecution(facts, definition),
  };
}

/** Re-entry versions are transient; the original item/recipe/actor defines one immutable automated launch. */
export async function assertStoredEvaluationLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  if (source.kind !== "evaluation")
    throw evaluationSourceRefusal("evaluation_launch_source_invalid");
  if (!controlledRecipesEnabled())
    throw evaluationSourceRefusal("evaluation_launch_disabled");
  const facts = await loadEvaluationLaunchFacts(db, source.id);
  const definition = definitionForSource(facts);

  if (!facts.batch.requestedByUserId)
    throw evaluationSourceRefusal("evaluation_launch_actor_missing");
  await assertTaskLaunchUserAuthority(
    db,
    facts.study.projectId,
    facts.batch.requestedByUserId,
    requiresLaunchUnattended(definition.executionPolicy)
      ? ["launchRun", "launchUnattended"]
      : ["launchRun"],
  );
  // Keep the same study-before-item order as participant finalization. Each
  // current source fact stays stable through the admitting/dispatch transaction.
  await db
    .select({ id: evaluationStudies.id })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, facts.study.id))
    .for("share");
  await db
    .select({ id: evaluationLaunchBatches.id })
    .from(evaluationLaunchBatches)
    .where(eq(evaluationLaunchBatches.id, facts.batch.id))
    .for("share");
  await db
    .select({ id: evaluationRecipes.id })
    .from(evaluationRecipes)
    .where(eq(evaluationRecipes.id, facts.recipe.id))
    .for("share");
  await db
    .select({ id: evaluationLaunchBatchItems.id })
    .from(evaluationLaunchBatchItems)
    .where(eq(evaluationLaunchBatchItems.id, facts.item.id))
    .for("share");
  const current = await loadEvaluationLaunchFacts(db, source.id);

  if (
    !["draft", "open"].includes(current.study.status) ||
    current.recipe.tombstonedAt ||
    !["queued", "launching", "launched"].includes(current.item.status)
  )
    throw evaluationSourceRefusal("evaluation_launch_source_closed");
  if (contentDigest(snapshotForSource(current)) !== contentDigest(source))
    throw evaluationSourceRefusal("evaluation_launch_source_changed");
}

/** Scope and frozen recipe come from the batch ledger, never a caller's force flag or supplied recipe object. */
export async function createEvaluationTaskLaunchSource(
  db: Db,
  selection: LaunchSelection,
): Promise<
  Readonly<{
    source: TaskLaunchServerSource;
    definition: EvaluationControlledRecipeDefinition;
  }>
> {
  const facts = await loadEvaluationLaunchFacts(db, selection.launchKey);

  if (
    facts.study.id !== selection.studyId ||
    facts.study.projectId !== selection.projectId ||
    facts.study.taskId !== selection.taskId ||
    facts.recipe.id !== selection.recipeId ||
    facts.item.replicateOrdinal !== selection.replicateOrdinal ||
    facts.batch.requestedByUserId !== selection.requestedByUserId ||
    contentDigest(parseControlledRecipe(selection.recipeDefinition)) !==
      facts.recipe.definitionDigest
  )
    throw evaluationSourceRefusal("evaluation_launch_source_invalid");
  const source = await createTaskLaunchServerSource(
    db,
    snapshotForSource(facts),
    assertStoredEvaluationLaunchSource,
  );

  return { source, definition: definitionForSource(facts) };
}
