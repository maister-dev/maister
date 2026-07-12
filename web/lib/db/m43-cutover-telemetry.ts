import "server-only";

import { sql, type SQL } from "drizzle-orm";

export const M43_CUTOVER_MIGRATION =
  "0094_postgres_graph_only_cutover" as const;

type SqlDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type M43CutoverCandidateTelemetry = {
  runId: string;
  priorStatus: string;
  nodeAttemptsClosed: number;
  hitlRequestsCancelled: number;
  assignmentsClosed: number;
  sessionsCleared: number;
};

export type M43CutoverTelemetry = {
  candidateCount: number;
  transitionedCount: number;
  nodeAttemptsClosed: number;
  hitlRequestsCancelled: number;
  assignmentsClosed: number;
  sessionsCleared: number;
  candidates: M43CutoverCandidateTelemetry[];
};

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];

  if (typeof value === "string" && value.length > 0) return value;

  throw new Error(`M43 cut-over telemetry returned invalid ${field}`);
}

function requiredCount(row: Record<string, unknown>, field: string): number {
  const raw = row[field];
  const value = typeof raw === "number" ? raw : Number(raw);

  if (Number.isInteger(value) && value >= 0) return value;

  throw new Error(`M43 cut-over telemetry returned invalid ${field}`);
}

function toCandidateTelemetry(
  row: Record<string, unknown>,
): M43CutoverCandidateTelemetry {
  return {
    runId: requiredString(row, "runId"),
    priorStatus: requiredString(row, "priorStatus"),
    nodeAttemptsClosed: requiredCount(row, "nodeAttemptsClosed"),
    hitlRequestsCancelled: requiredCount(row, "hitlRequestsCancelled"),
    assignmentsClosed: requiredCount(row, "assignmentsClosed"),
    sessionsCleared: requiredCount(row, "sessionsCleared"),
  };
}

function summarize(
  candidates: M43CutoverCandidateTelemetry[],
): M43CutoverTelemetry {
  return candidates.reduce<M43CutoverTelemetry>(
    (summary, candidate) => ({
      candidateCount: summary.candidateCount + 1,
      transitionedCount: summary.transitionedCount + 1,
      nodeAttemptsClosed:
        summary.nodeAttemptsClosed + candidate.nodeAttemptsClosed,
      hitlRequestsCancelled:
        summary.hitlRequestsCancelled + candidate.hitlRequestsCancelled,
      assignmentsClosed:
        summary.assignmentsClosed + candidate.assignmentsClosed,
      sessionsCleared: summary.sessionsCleared + candidate.sessionsCleared,
      candidates: [...summary.candidates, candidate],
    }),
    {
      candidateCount: 0,
      transitionedCount: 0,
      nodeAttemptsClosed: 0,
      hitlRequestsCancelled: 0,
      assignmentsClosed: 0,
      sessionsCleared: 0,
      candidates: [],
    },
  );
}

// Captures the exact pre-transaction D2 set. The deployment contract requires
// web and supervisor to be stopped, so these counts describe the mutations
// committed by 0093 after the migrator returns successfully.
export async function readM43CutoverTelemetry(
  db: SqlDb,
): Promise<M43CutoverTelemetry> {
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT
        r.id AS run_id,
        r.status AS prior_status
      FROM runs r
      LEFT JOIN flow_revisions fr ON fr.id = r.flow_revision_id
      LEFT JOIN flows f ON f.id = r.flow_id
      WHERE r.run_kind = 'flow'
        AND r.status IN (
          'Pending', 'Running', 'NeedsInput', 'NeedsInputIdle',
          'HumanWorking', 'WaitingOnChildren', 'Review', 'Crashed'
        )
        AND CASE
          WHEN r.flow_revision_id IS NOT NULL THEN fr.manifest ? 'steps'
          ELSE f.manifest ? 'steps'
        END
    )
    SELECT
      c.run_id AS "runId",
      c.prior_status AS "priorStatus",
      (
        SELECT COUNT(*)::int
        FROM node_attempts na
        WHERE na.run_id = c.run_id
          AND na.ended_at IS NULL
      ) AS "nodeAttemptsClosed",
      (
        SELECT COUNT(*)::int
        FROM hitl_requests h
        WHERE h.run_id = c.run_id
          AND h.responded_at IS NULL
      ) AS "hitlRequestsCancelled",
      (
        SELECT COUNT(*)::int
        FROM assignments a
        WHERE a.run_id = c.run_id
          AND a.status IN ('open', 'claimed')
      ) AS "assignmentsClosed",
      (
        SELECT COUNT(*)::int
        FROM run_sessions rs
        WHERE rs.run_id = c.run_id
          AND rs.acp_session_id IS NOT NULL
      ) AS "sessionsCleared"
    FROM candidates c
    ORDER BY c.run_id
  `);

  return summarize(result.rows.map(toCandidateTelemetry));
}

export function emptyM43CutoverTelemetry(): M43CutoverTelemetry {
  return summarize([]);
}
