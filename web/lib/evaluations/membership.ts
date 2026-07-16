import "server-only";

import { and, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { isExperimentMemberRun } from "@/lib/experiments/membership";

// FIXME(any): schema-module bridge (matches lib/experiments/membership.ts).
const { evaluationParticipants } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

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

// The unified launched-lineage predicate: true for a run launched as either a
// legacy Experiment member (`experiment_runs`) OR a canonical launched
// Evaluation participant (`evaluation_participants.source_type='launched'`).
// During the M46 compatibility window both representations coexist (the legacy
// route still writes `experiment_runs`; new recipe launches write launched
// participants), so EVERY no-auto-promotion / auto-delivery / relaunch consumer
// routes through this ONE predicate — observed participants can never leak into
// a launched-lineage decision, and the two representations can never drift.
export async function isLaunchedLineageRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  if (await isExperimentMemberRun(db, runId)) return true;

  return isLaunchedEvaluationRun(db, runId);
}
