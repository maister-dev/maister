import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): schema-module bridge (matches lib/evaluations/studies.ts).
const {
  evaluationExecutions,
  evaluationAggregateResults,
  evaluationMethodRevisions,
  evaluationProfiles,
  runs,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

export interface StudyExecutionView {
  id: string;
  status: string;
  terminalReason: string | null;
  methodQualifiedId: string | null;
  requestedAt: string | null;
  // The deterministic aggregate scoreboard (display-rounded), null until computed.
  aggregate: {
    displayTotal: number | null;
    perCriterion: Array<{ criterionId: string; displayValue: number | null }>;
    dispersion: Record<string, unknown> | null;
    warnings: string[] | null;
  } | null;
}

// The Study Lab execution scoreboard: every Evaluation Execution for a Study with
// its method + latest deterministic aggregate (display values only — never raw
// attempts or rationales). Ordered newest-first.
export async function listStudyExecutions(
  studyId: string,
  db?: Db,
): Promise<StudyExecutionView[]> {
  const d = db ?? getDb();
  const rows = (await d
    .select({
      id: evaluationExecutions.id,
      status: evaluationExecutions.status,
      terminalReason: evaluationExecutions.terminalReason,
      requestedAt: evaluationExecutions.requestedAt,
      methodQualifiedId: evaluationMethodRevisions.qualifiedId,
    })
    .from(evaluationExecutions)
    .leftJoin(
      evaluationMethodRevisions,
      eq(evaluationExecutions.methodRevisionId, evaluationMethodRevisions.id),
    )
    .where(eq(evaluationExecutions.studyId, studyId))
    .orderBy(desc(evaluationExecutions.requestedAt))) as Array<
    Record<string, any>
  >;

  const result: StudyExecutionView[] = [];

  for (const row of rows) {
    const [agg] = (await d
      .select({
        displayValues: evaluationAggregateResults.displayValues,
        dispersion: evaluationAggregateResults.dispersion,
        warnings: evaluationAggregateResults.warnings,
      })
      .from(evaluationAggregateResults)
      .where(eq(evaluationAggregateResults.executionId, row.id))
      .orderBy(desc(evaluationAggregateResults.revision))
      .limit(1)) as Array<Record<string, any>>;

    result.push({
      id: row.id,
      status: row.status,
      terminalReason: row.terminalReason ?? null,
      methodQualifiedId: row.methodQualifiedId ?? null,
      requestedAt:
        row.requestedAt instanceof Date ? row.requestedAt.toISOString() : null,
      aggregate: agg
        ? {
            displayTotal:
              (agg.displayValues?.displayTotal as number | undefined) ?? null,
            perCriterion: (agg.displayValues?.perCriterion ?? []) as Array<{
              criterionId: string;
              displayValue: number | null;
            }>,
            dispersion: agg.dispersion ?? null,
            warnings: agg.warnings ?? null,
          }
        : null,
    });
  }

  return result;
}

export interface EnabledProfileView {
  id: string;
  name: string;
}

// The enabled Evaluation Profiles a project user may launch a Study evaluation
// through (names + ids only). Disabled profiles are excluded — a disabled
// dependency blocks new starts (D8).
export async function listEnabledProfiles(
  db?: Db,
): Promise<EnabledProfileView[]> {
  const d = db ?? getDb();

  return (await d
    .select({ id: evaluationProfiles.id, name: evaluationProfiles.name })
    .from(evaluationProfiles)
    .where(eq(evaluationProfiles.enabled, true))
    .orderBy(evaluationProfiles.name)) as EnabledProfileView[];
}

export interface ComparableRunView {
  id: string;
  status: string;
  startedAt: string | null;
}

// Flow Runs for the Study's task that may be selected as OBSERVED participants
// (D3 — a scratch/agent run is not a task attempt). The service re-validates
// same-task/project + run kind at add time; this only lists candidates.
export async function listComparableTaskRuns(
  taskId: string,
  db?: Db,
): Promise<ComparableRunView[]> {
  const d = db ?? getDb();
  const rows = (await d
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt))) as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
  }));
}
