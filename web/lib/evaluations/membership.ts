import "server-only";

import type { Db } from "@/lib/evaluations/db";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { evaluationParticipants, evaluationStudies } from "@/lib/db/schema";

// A run is a launched evaluation participant iff a `launched`-source participant
// references it. OBSERVED participants (`source_type = 'observed'`) are excluded
// by construction — selecting an existing Run for comparison must NEVER change
// its promotion/delivery/relaunch behavior (ADR-142 D3; AC-01, AC-14).
// Membership is immutable per run: a tombstoned launched participant still holds
// its run (the forced evaluation promotion hold is immutable, ADR-146 D15), so
// `removed_at` is deliberately NOT filtered.
export async function isLaunchedEvaluationRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ runId: evaluationParticipants.runId })
    .from(evaluationParticipants)
    .where(
      and(
        eq(evaluationParticipants.runId, runId),
        eq(evaluationParticipants.sourceType, "launched"),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

// The launched-lineage predicate: true for a canonical launched Evaluation
// participant (`evaluation_participants.source_type='launched'`). EVERY
// no-auto-promotion / auto-delivery / relaunch consumer routes through this ONE
// predicate — observed participants can never leak into a launched-lineage
// decision. ADR-150 dropped the legacy `experiment_runs` leg: migration 0110
// already backfilled every historical experiment member into a launched
// evaluation participant, so they keep their launched semantics here.
export async function isLaunchedLineageRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  return isLaunchedEvaluationRun(db, runId);
}

// Studies still accepting lineage decisions. `decided`/`archived` are terminal:
// a restart of their participants launches as a PLAIN run (mirrors the
// experiments rule where a non-running/comparable experiment stops inheriting).
export const LIVE_EVALUATION_STUDY_STATUSES = ["draft", "open"] as const;

export type InheritedEvaluationParticipation = {
  studyId: string;
  recipeId: string | null;
  label: string;
  replicateGroup: string | null;
  replicateOrdinal: number | null;
  // Mirrored onto the successor row: a restart of a TOMBSTONED launched
  // participant still holds its replacement run (immutable hold, ADR-146 D15)
  // without re-surfacing it as a live study participant.
  sourceRemoved: boolean;
};

// The evaluation analogue of `deriveExperimentMembershipFromSource` (launch-side
// inheritance for relaunch/budget-restart of a launched participant). Returns
// the lineage fields the replacement run's SUCCESSOR participant row mirrors, or
// null when the source run is not a launched participant of a live study. The
// replicate ordinal is max+1 within the source's replicate group (falling back
// to its recipe), mirroring the experiments per-variant allocation.
export async function deriveEvaluationParticipationFromSource(
  db: Db,
  args: { sourceRunId: string; taskId: string },
): Promise<InheritedEvaluationParticipation | null> {
  const rows = await db
    .select({
      studyId: evaluationParticipants.studyId,
      recipeId: evaluationParticipants.recipeId,
      label: evaluationParticipants.label,
      replicateGroup: evaluationParticipants.replicateGroup,
      replicateOrdinal: evaluationParticipants.replicateOrdinal,
      removedAt: evaluationParticipants.removedAt,
    })
    .from(evaluationParticipants)
    .innerJoin(
      evaluationStudies,
      eq(evaluationStudies.id, evaluationParticipants.studyId),
    )
    .where(
      and(
        eq(evaluationParticipants.runId, args.sourceRunId),
        eq(evaluationParticipants.sourceType, "launched"),
        eq(evaluationStudies.taskId, args.taskId),
        inArray(evaluationStudies.status, [...LIVE_EVALUATION_STUDY_STATUSES]),
      ),
    )
    // Prefer the live row (partial unique guarantees at most one per study);
    // a tombstoned row still inherits — its run stays held, so the replacement
    // must too (otherwise the restart would be the escape hatch).
    .orderBy(
      sql`(${evaluationParticipants.removedAt} is null) desc`,
      desc(evaluationParticipants.joinedAt),
    )
    .limit(1);
  const source = rows[0];

  if (!source) return null;

  const ordinalScope = source.replicateGroup
    ? eq(evaluationParticipants.replicateGroup, source.replicateGroup)
    : source.recipeId
      ? eq(evaluationParticipants.recipeId, source.recipeId)
      : null;
  let replicateOrdinal: number | null = null;

  if (ordinalScope) {
    const [maxRow] = await db
      .select({
        max: sql<number>`coalesce(max(${evaluationParticipants.replicateOrdinal}), 0)`,
      })
      .from(evaluationParticipants)
      .where(
        and(
          eq(evaluationParticipants.studyId, source.studyId),
          eq(evaluationParticipants.sourceType, "launched"),
          ordinalScope,
        ),
      );

    replicateOrdinal = Number(maxRow?.max ?? 0) + 1;
  }

  return {
    studyId: source.studyId,
    recipeId: source.recipeId ?? null,
    label:
      replicateOrdinal === null
        ? `${source.label} (relaunch)`
        : `${source.label.replace(/ #\d+$/, "")} #${replicateOrdinal}`,
    replicateGroup: source.replicateGroup ?? null,
    replicateOrdinal,
    sourceRemoved: source.removedAt !== null,
  };
}
