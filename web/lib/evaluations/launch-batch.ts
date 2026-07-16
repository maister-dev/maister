import "server-only";

import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

// FIXME(any): schema-module bridge (matches lib/evaluations/studies.ts).
const {
  evaluationLaunchBatches,
  evaluationLaunchBatchItems,
  evaluationRecipes,
  evaluationParticipants,
  evaluationStudies,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-launch-batch",
  level: process.env.LOG_LEVEL ?? "info",
});

// The run-launch seam (M47 D17). The default adapter (co-evolve, T6.4 wiring)
// calls `launchRun({ autoPromote: false, ... })` with the T6.2-resolved slot map;
// tests inject a stub so the durable batch FSM (crash/partial/dedup/retry +
// launched-participant lineage) is verified without the whole run-launch stack —
// the same injectable-seam discipline as the T4.1 judge-spawn seam.
export interface LaunchRunSeam {
  (args: {
    studyId: string;
    projectId: string;
    taskId: string;
    recipeId: string;
    recipeDefinition: EvaluationControlledRecipeDefinition;
    replicateOrdinal: number;
    requestedByUserId: string | null;
  }): Promise<{ runId: string }>;
}

export interface CreateLaunchBatchArgs {
  studyId: string;
  projectId: string;
  requestedByUserId?: string | null;
  idempotencyKey?: string | null;
  // Which recipes to launch and how many replicates each. `replicateCount`
  // defaults to the recipe's own replicatePolicy.count (or 1).
  items: Array<{ recipeId: string; replicateCount?: number }>;
}

export interface CreateLaunchBatchResult {
  batchId: string;
  deduped: boolean;
  itemCount: number;
}

// Rollout kill switch (M47 T6.5): controlled (launched) recipes can be disabled
// platform-wide independently of observed Studies if a rollout degrades, without
// touching M46 observed-comparison. Default ENABLED; ops sets
// `MAISTER_CONTROLLED_RECIPES_ENABLED=false` to freeze new controlled launches.
// Observed participants and existing launched runs are unaffected.
export function controlledRecipesEnabled(): boolean {
  return process.env.MAISTER_CONTROLLED_RECIPES_ENABLED !== "false";
}

// Persist a durable controlled-launch batch intent BEFORE any run-launch side
// effect (D17). Idempotency-keyed: a duplicate submit returns the original batch.
// Validates every recipe belongs to the study and is not tombstoned; a bad recipe
// on item B refuses the whole batch (no partial write).
export async function createControlledLaunchBatch(
  args: CreateLaunchBatchArgs,
  db?: Db,
): Promise<CreateLaunchBatchResult> {
  const d = db ?? getDb();

  if (!controlledRecipesEnabled()) {
    throw new MaisterError(
      "CONFIG",
      "controlled evaluation recipes are disabled on this platform",
    );
  }
  if (args.items.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "launch batch requires at least one recipe",
    );
  }

  return d.transaction(async (tx: Db) => {
    const [study] = await tx
      .select({
        id: evaluationStudies.id,
        projectId: evaluationStudies.projectId,
        status: evaluationStudies.status,
      })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId));

    if (!study || study.projectId !== args.projectId) {
      throw new MaisterError(
        "PRECONDITION",
        `study ${args.studyId} not found in project ${args.projectId}`,
      );
    }
    if (study.status === "archived" || study.status === "decided") {
      throw new MaisterError(
        "CONFLICT",
        `study ${args.studyId} is ${study.status}; cannot launch new participants`,
      );
    }

    if (args.idempotencyKey) {
      const [existing] = await tx
        .select({ id: evaluationLaunchBatches.id })
        .from(evaluationLaunchBatches)
        .where(eq(evaluationLaunchBatches.idempotencyKey, args.idempotencyKey));

      if (existing) {
        const items = await tx
          .select({ id: evaluationLaunchBatchItems.id })
          .from(evaluationLaunchBatchItems)
          .where(eq(evaluationLaunchBatchItems.batchId, existing.id));

        return {
          batchId: existing.id,
          deduped: true,
          itemCount: items.length,
        };
      }
    }

    const recipeIds = [...new Set(args.items.map((i) => i.recipeId))];
    const recipeRows = await tx
      .select({
        id: evaluationRecipes.id,
        studyId: evaluationRecipes.studyId,
        definition: evaluationRecipes.definition,
        tombstonedAt: evaluationRecipes.tombstonedAt,
      })
      .from(evaluationRecipes)
      .where(inArray(evaluationRecipes.id, recipeIds));
    const recipeById = new Map<string, Record<string, any>>(
      recipeRows.map((r: Record<string, any>) => [r.id as string, r]),
    );

    for (const item of args.items) {
      const recipe = recipeById.get(item.recipeId);

      if (!recipe || recipe.studyId !== args.studyId) {
        throw new MaisterError(
          "PRECONDITION",
          `recipe ${item.recipeId} not found in study ${args.studyId}`,
        );
      }
      if (recipe.tombstonedAt) {
        throw new MaisterError(
          "CONFLICT",
          `recipe ${item.recipeId} is tombstoned and cannot be launched`,
        );
      }
      // Strict-parse the stored definition — a legacy/opaque recipe cannot drive
      // a controlled launch (M47 requires the typed D16 contract).
      parseControlledRecipe(recipe.definition);
    }

    const [batch] = await tx
      .insert(evaluationLaunchBatches)
      .values({
        studyId: args.studyId,
        status: "queued",
        idempotencyKey: args.idempotencyKey ?? null,
        requestedByUserId: args.requestedByUserId ?? null,
      })
      .returning();

    const itemRows: Array<Record<string, unknown>> = [];

    for (const item of args.items) {
      // Validated present in the loop above; the `!` is the same invariant.
      const recipe = recipeById.get(item.recipeId)!;
      const parsed = parseControlledRecipe(recipe.definition);
      const count = item.replicateCount ?? parsed.replicatePolicy?.count ?? 1;

      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        itemRows.push({
          batchId: batch.id,
          recipeId: item.recipeId,
          replicateOrdinal: ordinal,
          status: "queued",
        });
      }
    }

    await tx.insert(evaluationLaunchBatchItems).values(itemRows);

    log.info(
      { batchId: batch.id, studyId: args.studyId, itemCount: itemRows.length },
      "controlled launch batch intent persisted",
    );

    return { batchId: batch.id, deduped: false, itemCount: itemRows.length };
  });
}

function launchReasonForOrdinal(ordinal: number): "initial" | "replicate" {
  return ordinal <= 1 ? "initial" : "replicate";
}

// Drive a batch's queued items to terminal state (D17). Each item is claimed
// with a CAS queued→launching (crash-safe: a claim that loses the race is an
// idempotent skip), launched via the seam, then written launched|failed. Every
// launched participant is created with launched lineage (recipeId + replicate
// ordinal) so `isLaunchedLineageRun` excludes it from auto-promotion/delivery,
// and the run itself carries the forced promotion hold via the seam's
// `autoPromote:false`. Returns the per-item outcome counts.
export async function runControlledLaunchBatch(
  batchId: string,
  seam: LaunchRunSeam,
  db?: Db,
): Promise<{ launched: number; failed: number; skipped: number }> {
  const d = db ?? getDb();

  const [batch] = await d
    .select({
      id: evaluationLaunchBatches.id,
      studyId: evaluationLaunchBatches.studyId,
      requestedByUserId: evaluationLaunchBatches.requestedByUserId,
    })
    .from(evaluationLaunchBatches)
    .where(eq(evaluationLaunchBatches.id, batchId));

  if (!batch) {
    throw new MaisterError(
      "PRECONDITION",
      `launch batch not found: ${batchId}`,
    );
  }

  const [study] = await d
    .select({
      id: evaluationStudies.id,
      projectId: evaluationStudies.projectId,
      taskId: evaluationStudies.taskId,
    })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, batch.studyId));

  const queued = await d
    .select({
      id: evaluationLaunchBatchItems.id,
      recipeId: evaluationLaunchBatchItems.recipeId,
      replicateOrdinal: evaluationLaunchBatchItems.replicateOrdinal,
      version: evaluationLaunchBatchItems.version,
      attempt: evaluationLaunchBatchItems.attempt,
    })
    .from(evaluationLaunchBatchItems)
    .where(
      and(
        eq(evaluationLaunchBatchItems.batchId, batchId),
        eq(evaluationLaunchBatchItems.status, "queued"),
      ),
    );

  let launched = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of queued) {
    // CAS claim: queued → launching. A lost race means another worker owns it.
    const claim = await d
      .update(evaluationLaunchBatchItems)
      .set({
        status: "launching",
        version: sql`${evaluationLaunchBatchItems.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(evaluationLaunchBatchItems.id, item.id),
          eq(evaluationLaunchBatchItems.status, "queued"),
          eq(evaluationLaunchBatchItems.version, item.version),
        ),
      )
      .returning({ id: evaluationLaunchBatchItems.id });

    if (!claim.length) {
      skipped += 1;
      continue;
    }

    try {
      const [recipe] = await d
        .select({
          id: evaluationRecipes.id,
          label: evaluationRecipes.label,
          key: evaluationRecipes.key,
          definition: evaluationRecipes.definition,
        })
        .from(evaluationRecipes)
        .where(eq(evaluationRecipes.id, item.recipeId));
      const definition = parseControlledRecipe(recipe.definition);

      const { runId } = await seam({
        studyId: batch.studyId,
        projectId: study.projectId,
        taskId: study.taskId,
        recipeId: item.recipeId,
        recipeDefinition: definition,
        replicateOrdinal: item.replicateOrdinal,
        requestedByUserId: batch.requestedByUserId ?? null,
      });

      const participantId = await d.transaction(async (tx: Db) => {
        const [participant] = await tx
          .insert(evaluationParticipants)
          .values({
            studyId: batch.studyId,
            runId,
            sourceType: "launched",
            recipeId: item.recipeId,
            label: `${recipe.label} #${item.replicateOrdinal}`,
            replicateGroup: definition.replicatePolicy?.groupKey ?? recipe.key,
            replicateOrdinal: item.replicateOrdinal,
            launchReason: launchReasonForOrdinal(item.replicateOrdinal),
            runIdentity: {
              runId,
              taskId: study.taskId,
              flowRefId: definition.flow.flowRefId,
              flowRevisionId: definition.flow.flowRevisionId,
              capturedAt: new Date().toISOString(),
            },
          })
          .returning({ id: evaluationParticipants.id });

        // First launched participant flips a draft study to open (guarded).
        await tx
          .update(evaluationStudies)
          .set({ status: "open", updatedAt: new Date() })
          .where(
            and(
              eq(evaluationStudies.id, batch.studyId),
              eq(evaluationStudies.status, "draft"),
            ),
          );

        return participant.id as string;
      });

      await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "launched",
          runId,
          participantId,
          errorReason: null,
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(eq(evaluationLaunchBatchItems.id, item.id));
      launched += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "failed",
          errorReason: reason,
          attempt: sql`${evaluationLaunchBatchItems.attempt} + 1`,
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(eq(evaluationLaunchBatchItems.id, item.id));
      failed += 1;
      log.warn(
        { batchId, itemId: item.id, reason },
        "controlled launch batch item failed",
      );
    }
  }

  await finalizeBatchStatus(batchId, d);

  return { launched, failed, skipped };
}

// Recompute + persist the batch-level status from its items' terminal states.
// completed = all launched; failed = all failed; partial = a mix; still
// launching = any queued/launching remain.
async function finalizeBatchStatus(batchId: string, d: Db): Promise<void> {
  const items = await d
    .select({ status: evaluationLaunchBatchItems.status })
    .from(evaluationLaunchBatchItems)
    .where(eq(evaluationLaunchBatchItems.batchId, batchId));
  const statuses = items.map((i: Record<string, unknown>) => i.status);
  const pending = statuses.some(
    (s: string) => s === "queued" || s === "launching",
  );
  const anyLaunched = statuses.some((s: string) => s === "launched");
  const anyFailed = statuses.some((s: string) => s === "failed");

  const status = pending
    ? "launching"
    : anyLaunched && anyFailed
      ? "partial"
      : anyLaunched
        ? "completed"
        : "failed";

  await d
    .update(evaluationLaunchBatches)
    .set({
      status,
      updatedAt: new Date(),
      ...(pending ? {} : { completedAt: new Date() }),
      version: sql`${evaluationLaunchBatches.version} + 1`,
    })
    .where(eq(evaluationLaunchBatches.id, batchId));
}

// Re-queue a batch's failed items for another drive pass, bounded by
// `maxAttempts` (retry/adopt, D17). Returns how many were re-queued.
export async function retryFailedBatchItems(
  batchId: string,
  maxAttempts: number,
  db?: Db,
): Promise<{ requeued: number }> {
  const d = db ?? getDb();
  const requeued = await d
    .update(evaluationLaunchBatchItems)
    .set({
      status: "queued",
      errorReason: null,
      updatedAt: new Date(),
      version: sql`${evaluationLaunchBatchItems.version} + 1`,
    })
    .where(
      and(
        eq(evaluationLaunchBatchItems.batchId, batchId),
        eq(evaluationLaunchBatchItems.status, "failed"),
        sql`${evaluationLaunchBatchItems.attempt} < ${maxAttempts}`,
      ),
    )
    .returning({ id: evaluationLaunchBatchItems.id });

  return { requeued: requeued.length };
}
