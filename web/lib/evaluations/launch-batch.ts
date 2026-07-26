import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  evaluationLaunchBatchItems,
  evaluationLaunchBatches,
  evaluationParticipants,
  evaluationRecipes,
  evaluationStudies,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

const log = pino({
  name: "evaluations-launch-batch",
  level: process.env.LOG_LEVEL ?? "info",
});

// The run-launch seam (M47 D17). The default adapter (co-evolve, T6.4 wiring)
// calls `launchRun({ autoPromote: false, ... })` with the T6.2-resolved slot map;
// tests inject a stub so the durable batch FSM (crash/partial/dedup/retry +
// launched-participant lineage) is verified without the whole run-launch stack —
// the same injectable-seam discipline as the T4.1 judge-spawn seam.
// CONTRACT: `launchKey` (the batch item id, stable across retries) is the
// adapter's dedup handle — a re-driven item re-invokes the seam with the SAME
// key and MUST get the same run back, never a second one. The crash-recovery
// paths below are convergent only under this contract.
export interface LaunchRunSeam {
  (args: {
    studyId: string;
    projectId: string;
    taskId: string;
    recipeId: string;
    recipeDefinition: EvaluationControlledRecipeDefinition;
    replicateOrdinal: number;
    launchKey: string;
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
// effect (D17). Idempotency-keyed within the Study: a duplicate submit with the
// same request digest returns the original batch; the same key with a DIFFERENT
// request is a CONFLICT. Validates every recipe belongs to the study and is not
// tombstoned; a bad recipe on item B refuses the whole batch (no partial write).
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

  const requestDigest = contentDigest({
    items: args.items.map((i) => ({
      recipeId: i.recipeId,
      replicateCount: i.replicateCount ?? null,
    })),
  });

  const replayOrConflict = async (
    existing: { id: string; requestDigest: string | null },
    tx: Db,
  ): Promise<CreateLaunchBatchResult> => {
    if (existing.requestDigest !== requestDigest) {
      throw new MaisterError(
        "CONFLICT",
        `idempotency key "${args.idempotencyKey}" was already used for a different launch request in study ${args.studyId}`,
      );
    }

    const items = await tx
      .select({ id: evaluationLaunchBatchItems.id })
      .from(evaluationLaunchBatchItems)
      .where(eq(evaluationLaunchBatchItems.batchId, existing.id));

    return { batchId: existing.id, deduped: true, itemCount: items.length };
  };

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
        .select({
          id: evaluationLaunchBatches.id,
          requestDigest: evaluationLaunchBatches.requestDigest,
        })
        .from(evaluationLaunchBatches)
        .where(
          and(
            eq(evaluationLaunchBatches.studyId, args.studyId),
            eq(evaluationLaunchBatches.idempotencyKey, args.idempotencyKey),
          ),
        );

      if (existing) {
        return replayOrConflict(existing, tx);
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
    const recipeById = new Map(recipeRows.map((r) => [r.id, r]));

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

    const insertedBatch = await tx
      .insert(evaluationLaunchBatches)
      .values({
        studyId: args.studyId,
        status: "queued",
        idempotencyKey: args.idempotencyKey ?? null,
        requestDigest,
        requestedByUserId: args.requestedByUserId ?? null,
      })
      .onConflictDoNothing({
        target: [
          evaluationLaunchBatches.studyId,
          evaluationLaunchBatches.idempotencyKey,
        ],
        where: sql`idempotency_key is not null`,
      })
      .returning();

    if (!insertedBatch.length) {
      // A concurrent same-key submit won the (study, key) unique race while
      // this transaction was in flight — converge on the winner, never 23505.
      const [winner] = await tx
        .select({
          id: evaluationLaunchBatches.id,
          requestDigest: evaluationLaunchBatches.requestDigest,
        })
        .from(evaluationLaunchBatches)
        .where(
          and(
            eq(evaluationLaunchBatches.studyId, args.studyId),
            eq(
              evaluationLaunchBatches.idempotencyKey,
              args.idempotencyKey ?? "",
            ),
          ),
        );

      if (!winner) {
        throw new MaisterError(
          "CONFLICT",
          `launch batch insert conflicted but no winner row is visible (study ${args.studyId})`,
        );
      }

      return replayOrConflict(winner, tx);
    }

    const batch = insertedBatch[0];

    const itemRows: Array<typeof evaluationLaunchBatchItems.$inferInsert> = [];

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

// Launch-time admission gate, re-checked per item at drive/retry time — NOT
// only at batch create. A durable queued batch must not keep launching after a
// platform freeze (kill switch), a study decision/archival, or a recipe
// tombstone. `draft` stays launchable: the first launched participant is what
// flips a draft study to open.
type LaunchAdmission =
  | { verdict: "launch" }
  | { verdict: "halt_kill_switch" }
  | {
      verdict: "terminalize";
      reason: "STUDY_NOT_LAUNCHABLE" | "RECIPE_TOMBSTONED";
    };

const LAUNCHABLE_STUDY_STATUSES = ["draft", "open"] as const;

async function assessLaunchAdmission(
  args: { studyId: string; recipeId: string },
  d: Db,
): Promise<LaunchAdmission> {
  if (!controlledRecipesEnabled()) {
    return { verdict: "halt_kill_switch" };
  }

  const [study] = await d
    .select({ status: evaluationStudies.status })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, args.studyId));

  if (
    !study ||
    !(LAUNCHABLE_STUDY_STATUSES as readonly string[]).includes(study.status)
  ) {
    return { verdict: "terminalize", reason: "STUDY_NOT_LAUNCHABLE" };
  }

  const [recipe] = await d
    .select({ tombstonedAt: evaluationRecipes.tombstonedAt })
    .from(evaluationRecipes)
    .where(eq(evaluationRecipes.id, args.recipeId));

  if (!recipe || recipe.tombstonedAt) {
    return { verdict: "terminalize", reason: "RECIPE_TOMBSTONED" };
  }

  return { verdict: "launch" };
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

  // ADR-150 (adversarial fix B5): the kill switch is consulted at the TOP of the
  // drive, before stuck-recovery and the queued loop. Read only inside per-item
  // admission (below), a frozen platform still mutated item rows and could move
  // one to `launched`. Halting here keeps the documented contract: items stay
  // queued, nothing is mutated. No run ever escaped the freeze regardless.
  if (!controlledRecipesEnabled()) {
    log.warn(
      { batchId },
      "controlled recipes kill switch is off; batch drive refused at entry",
    );

    return { launched: 0, failed: 0, skipped: 0 };
  }

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

  // Crash recovery: a drive that died mid-item leaves it in `launching`. The
  // participant's batch_item_id is the adoption anchor — if it exists, finish
  // the bookkeeping; otherwise return the item to `queued` so this pass
  // re-drives it (the seam's launchKey contract converges onto the same run).
  const stuck = await d
    .select({
      id: evaluationLaunchBatchItems.id,
      version: evaluationLaunchBatchItems.version,
    })
    .from(evaluationLaunchBatchItems)
    .where(
      and(
        eq(evaluationLaunchBatchItems.batchId, batchId),
        eq(evaluationLaunchBatchItems.status, "launching"),
      ),
    );

  for (const item of stuck) {
    const [existingParticipant] = await d
      .select({
        id: evaluationParticipants.id,
        runId: evaluationParticipants.runId,
      })
      .from(evaluationParticipants)
      .where(eq(evaluationParticipants.batchItemId, item.id));

    if (existingParticipant) {
      await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "launched",
          runId: existingParticipant.runId,
          participantId: existingParticipant.id,
          errorReason: null,
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(
          and(
            eq(evaluationLaunchBatchItems.id, item.id),
            eq(evaluationLaunchBatchItems.status, "launching"),
          ),
        );
      log.warn(
        { batchId, itemId: item.id, participantId: existingParticipant.id },
        "adopted stuck launching item via existing participant",
      );
    } else {
      await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "queued",
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(
          and(
            eq(evaluationLaunchBatchItems.id, item.id),
            eq(evaluationLaunchBatchItems.status, "launching"),
            eq(evaluationLaunchBatchItems.version, item.version),
          ),
        );
      log.warn(
        { batchId, itemId: item.id },
        "re-queued stuck launching item (no participant recorded)",
      );
    }
  }

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
    // Governance re-check BEFORE any claim or seam call: kill switch off halts
    // the drain (items stay queued); a closed study or tombstoned recipe
    // terminalizes the item with a typed reason — no launch.
    const admission = await assessLaunchAdmission(
      { studyId: batch.studyId, recipeId: item.recipeId },
      d,
    );

    if (admission.verdict === "halt_kill_switch") {
      log.warn(
        { batchId },
        "controlled recipes kill switch is off; batch drive halted, remaining items left queued",
      );
      break;
    }
    if (admission.verdict === "terminalize") {
      const terminalized = await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "failed",
          errorReason: admission.reason,
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(
          and(
            eq(evaluationLaunchBatchItems.id, item.id),
            eq(evaluationLaunchBatchItems.status, "queued"),
            eq(evaluationLaunchBatchItems.version, item.version),
          ),
        )
        .returning({ id: evaluationLaunchBatchItems.id });

      if (terminalized.length) {
        failed += 1;
        log.warn(
          { batchId, itemId: item.id, reason: admission.reason },
          "launch batch item terminalized before launch",
        );
      } else {
        skipped += 1;
      }
      continue;
    }

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
        launchKey: item.id,
        requestedByUserId: batch.requestedByUserId ?? null,
      });

      // Participant creation, the draft→open flip, and the item bookkeeping
      // commit ATOMICALLY — a crash never leaves a participant without its
      // launched item record (or vice versa). The batch_item_id conflict path
      // adopts a participant a crashed prior drive already created.
      await d.transaction(async (tx: Db) => {
        // ADR-150 (adversarial fix B2): admission is checked before the CAS
        // claim, but the seam call can run for minutes. Re-read the study status
        // UNDER this tx before writing the participant — otherwise a study that
        // became `decided`/`archived` during the launch still acquires a
        // launched participant. FOR UPDATE serializes against a concurrent
        // verdict flip on the same study row.
        const [liveStudy] = await tx
          .select({ status: evaluationStudies.status })
          .from(evaluationStudies)
          .where(eq(evaluationStudies.id, batch.studyId))
          .for("update");

        if (
          !liveStudy ||
          !(LAUNCHABLE_STUDY_STATUSES as readonly string[]).includes(
            liveStudy.status,
          )
        ) {
          throw new MaisterError(
            "CONFLICT",
            `study ${batch.studyId} became non-launchable during the launch`,
          );
        }

        // ADR-150 provenance: record the ACTUAL revision the run launched with,
        // read back from the run row — never the recipe's declared pin taken on
        // faith — so evidence can never attribute a result to a revision that
        // did not produce it. Since Codex-1 (C) the default seam threads the pin
        // (`evaluationFlowRevisionId`), so actual == pin by construction; the
        // read-back stays as the honest recorder for ANY seam implementation.
        // `flowRefId` is stable (only the revision drifts on a package
        // upgrade), so it stays from the recipe.
        const [launchedRun] = await tx
          .select({ flowRevisionId: runs.flowRevisionId })
          .from(runs)
          .where(eq(runs.id, runId));
        const actualFlowRevisionId =
          launchedRun?.flowRevisionId ?? definition.flow.flowRevisionId;

        const insertedParticipant = await tx
          .insert(evaluationParticipants)
          .values({
            studyId: batch.studyId,
            runId,
            sourceType: "launched",
            recipeId: item.recipeId,
            batchItemId: item.id,
            label: `${recipe.label} #${item.replicateOrdinal}`,
            replicateGroup: definition.replicatePolicy?.groupKey ?? recipe.key,
            replicateOrdinal: item.replicateOrdinal,
            launchReason: launchReasonForOrdinal(item.replicateOrdinal),
            runIdentity: {
              runId,
              taskId: study.taskId,
              flowRefId: definition.flow.flowRefId,
              flowRevisionId: actualFlowRevisionId,
              capturedAt: new Date().toISOString(),
            },
          })
          .onConflictDoNothing({
            target: [evaluationParticipants.batchItemId],
            where: sql`batch_item_id is not null`,
          })
          .returning({
            id: evaluationParticipants.id,
            runId: evaluationParticipants.runId,
          });

        let participant = insertedParticipant[0];

        if (!participant) {
          const [adoptedRow] = await tx
            .select({
              id: evaluationParticipants.id,
              runId: evaluationParticipants.runId,
            })
            .from(evaluationParticipants)
            .where(eq(evaluationParticipants.batchItemId, item.id));

          if (!adoptedRow) {
            throw new MaisterError(
              "CONFLICT",
              `participant insert conflicted for batch item ${item.id} but no participant is visible`,
            );
          }
          participant = adoptedRow;
        }

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

        // ADR-150 (adversarial fix B2): status-guarded like the failure path.
        // The seam call can run for minutes; a concurrent stuck-recovery drive
        // could terminalize this item (study decided → `failed`) in that window.
        // Without the `status='launching'` guard this write resurrects it
        // `failed → launched` and lets a decided study acquire a participant.
        const finalized = await tx
          .update(evaluationLaunchBatchItems)
          .set({
            status: "launched",
            // The participant row is authoritative when adopting a crashed
            // drive's work — its runId is the run that really got linked.
            runId: participant.runId ?? runId,
            participantId: participant.id,
            errorReason: null,
            updatedAt: new Date(),
            version: sql`${evaluationLaunchBatchItems.version} + 1`,
          })
          .where(
            and(
              eq(evaluationLaunchBatchItems.id, item.id),
              eq(evaluationLaunchBatchItems.status, "launching"),
            ),
          )
          .returning({ id: evaluationLaunchBatchItems.id });

        // Lost the guard: another drive already terminalized this item. The run
        // we just launched is adopted by that item's own record via the
        // launchKey binding — do NOT double-count it as launched here.
        if (finalized.length === 0) {
          throw new MaisterError(
            "CONFLICT",
            `launch batch item ${item.id} was terminalized concurrently`,
          );
        }
      });
      launched += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // The persisted reason is a bounded typed code, never raw error text
      // (a message may embed host paths); the full error stays in the log.
      const errorCode = err instanceof MaisterError ? err.code : "CRASH";

      // Status-guarded: a slow concurrent drive that already finalized this
      // item to `launched` must not be clobbered by a stale failure.
      await d
        .update(evaluationLaunchBatchItems)
        .set({
          status: "failed",
          errorReason: errorCode,
          attempt: sql`${evaluationLaunchBatchItems.attempt} + 1`,
          updatedAt: new Date(),
          version: sql`${evaluationLaunchBatchItems.version} + 1`,
        })
        .where(
          and(
            eq(evaluationLaunchBatchItems.id, item.id),
            eq(evaluationLaunchBatchItems.status, "launching"),
          ),
        );
      failed += 1;
      log.warn(
        { batchId, itemId: item.id, reason, code: errorCode },
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
  // ADR-150 hardening: a create-drive and a retry-drive can run fire-and-forget
  // on the SAME batch concurrently, and each ends by recomputing + overwriting
  // the batch status. Lock the batch row FOR UPDATE and recompute from the
  // items' COMMITTED states UNDER the lock, so the two finalizes serialize and
  // the last one writes the correct status — a stale non-terminal read can never
  // clobber a terminal `completed`/`partial`/`failed` into a permanent
  // `launching`.
  await d.transaction(async (tx: Db) => {
    await tx
      .select({ id: evaluationLaunchBatches.id })
      .from(evaluationLaunchBatches)
      .where(eq(evaluationLaunchBatches.id, batchId))
      .for("update");

    const items = await tx
      .select({ status: evaluationLaunchBatchItems.status })
      .from(evaluationLaunchBatchItems)
      .where(eq(evaluationLaunchBatchItems.batchId, batchId));
    const statuses = items.map((i) => i.status);
    const pending = statuses.some((s) => s === "queued" || s === "launching");
    const anyLaunched = statuses.some((s) => s === "launched");
    const anyFailed = statuses.some((s) => s === "failed");

    const status = pending
      ? "launching"
      : anyLaunched && anyFailed
        ? "partial"
        : anyLaunched
          ? "completed"
          : "failed";

    await tx
      .update(evaluationLaunchBatches)
      .set({
        status,
        updatedAt: new Date(),
        ...(pending ? {} : { completedAt: new Date() }),
        version: sql`${evaluationLaunchBatches.version} + 1`,
      })
      .where(eq(evaluationLaunchBatches.id, batchId));
  });
}

// Re-queue a batch's failed items for another drive pass, bounded by
// `maxAttempts` (retry/adopt, D17). Governance-gated like the drive loop:
// refuses under the kill switch or a non-launchable study, and never
// re-queues an item whose recipe was tombstoned. Returns how many were
// re-queued.
export async function retryFailedBatchItems(
  batchId: string,
  maxAttempts: number,
  db?: Db,
): Promise<{ requeued: number }> {
  const d = db ?? getDb();

  if (!controlledRecipesEnabled()) {
    log.warn(
      { batchId },
      "controlled recipes kill switch is off; retry refused, items left failed",
    );

    return { requeued: 0 };
  }

  const [batch] = await d
    .select({
      id: evaluationLaunchBatches.id,
      studyId: evaluationLaunchBatches.studyId,
    })
    .from(evaluationLaunchBatches)
    .where(eq(evaluationLaunchBatches.id, batchId));

  if (!batch) {
    return { requeued: 0 };
  }

  const [study] = await d
    .select({ status: evaluationStudies.status })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, batch.studyId));

  if (
    !study ||
    !(LAUNCHABLE_STUDY_STATUSES as readonly string[]).includes(study.status)
  ) {
    log.warn(
      { batchId, studyStatus: study?.status ?? "missing" },
      "study is not launchable; retry refused",
    );

    return { requeued: 0 };
  }

  const tombstonedRecipeIds = (
    await d
      .select({ id: evaluationRecipes.id })
      .from(evaluationRecipes)
      .where(
        and(
          eq(evaluationRecipes.studyId, batch.studyId),
          isNotNull(evaluationRecipes.tombstonedAt),
        ),
      )
  ).map((r) => r.id);

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
        ...(tombstonedRecipeIds.length
          ? [
              notInArray(
                evaluationLaunchBatchItems.recipeId,
                tombstonedRecipeIds,
              ),
            ]
          : []),
      ),
    )
    .returning({ id: evaluationLaunchBatchItems.id });

  return { requeued: requeued.length };
}

export interface LaunchBatchItemDto {
  id: string;
  recipeId: string;
  replicateOrdinal: number;
  status: string;
  runId: string | null;
  participantId: string | null;
  attempt: number;
  errorReason: string | null;
}

export interface LaunchBatchDto {
  id: string;
  studyId: string;
  status: string;
  idempotencyKey: string | null;
  completedAt: string | null;
  createdAt: string;
  items: LaunchBatchItemDto[];
}

// Read a batch + its per-item state, ownership-scoped to the study. A batchId
// belonging to another study is hidden as PRECONDITION (route → 404), matching
// the study-ownership guard on every other evaluation route.
export async function getLaunchBatchForStudy(
  args: { studyId: string; batchId: string },
  db?: Db,
): Promise<LaunchBatchDto> {
  const d = db ?? getDb();

  const [batch] = await d
    .select({
      id: evaluationLaunchBatches.id,
      studyId: evaluationLaunchBatches.studyId,
      status: evaluationLaunchBatches.status,
      idempotencyKey: evaluationLaunchBatches.idempotencyKey,
      completedAt: evaluationLaunchBatches.completedAt,
      createdAt: evaluationLaunchBatches.createdAt,
    })
    .from(evaluationLaunchBatches)
    .where(
      and(
        eq(evaluationLaunchBatches.id, args.batchId),
        eq(evaluationLaunchBatches.studyId, args.studyId),
      ),
    );

  if (!batch) {
    throw new MaisterError(
      "PRECONDITION",
      `launch batch not found: ${args.batchId}`,
    );
  }

  const items = await d
    .select({
      id: evaluationLaunchBatchItems.id,
      recipeId: evaluationLaunchBatchItems.recipeId,
      replicateOrdinal: evaluationLaunchBatchItems.replicateOrdinal,
      status: evaluationLaunchBatchItems.status,
      runId: evaluationLaunchBatchItems.runId,
      participantId: evaluationLaunchBatchItems.participantId,
      attempt: evaluationLaunchBatchItems.attempt,
      errorReason: evaluationLaunchBatchItems.errorReason,
    })
    .from(evaluationLaunchBatchItems)
    .where(eq(evaluationLaunchBatchItems.batchId, args.batchId))
    .orderBy(evaluationLaunchBatchItems.replicateOrdinal);

  return {
    id: batch.id,
    studyId: batch.studyId,
    status: batch.status,
    idempotencyKey: batch.idempotencyKey,
    completedAt: batch.completedAt ? batch.completedAt.toISOString() : null,
    createdAt: batch.createdAt.toISOString(),
    items,
  };
}
