import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ContextSnapshot } from "./context-snapshot";

import { sql } from "drizzle-orm";

import { claudeContextWindow } from "../../../runtime/acp-context";

import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";

type SnapshotRow = Omit<
  ContextSnapshot,
  "type" | "runId" | "nodeAttemptId" | "usage" | "coverage" | "windowAdvisory"
> & {
  used: string | null;
  size: string | null;
  observedAt: Date | null;
  usageSequence: string | null;
  hasCreatedEvent: boolean;
  adapter: string | null;
  providerKind: string | null;
  configured: string | null;
};

export async function readContextSnapshot(
  db: Pick<Db, "execute">,
  runId: string,
  nodeAttemptId: string | null = null,
): Promise<ContextSnapshot> {
  const selectedAttempt =
    nodeAttemptId !== null
      ? sql`(i.context_node_attempt_id = ${nodeAttemptId}
        OR EXISTS (SELECT 1 FROM run_context_usage u0
          WHERE u0.run_id = i.run_id AND u0.node_attempt_id = ${nodeAttemptId}
            AND u0.host_session_id = i.host_session_id
            AND u0.execution_host_id = i.execution_host_id
            AND u0.assignment_id = i.execution_assignment_id
            AND u0.assignment_epoch = i.assignment_epoch))`
      : sql`i.host_session_id = rs.host_session_id
        AND i.execution_assignment_id = rs.execution_assignment_id`;
  const usageScope =
    nodeAttemptId === null
      ? sql`u.node_attempt_id IS NULL`
      : sql`u.node_attempt_id = ${nodeAttemptId}`;
  const transcriptScope =
    nodeAttemptId === null
      ? sql`t.node_attempt_id IS NULL`
      : sql`t.node_attempt_id = ${nodeAttemptId}`;
  const result = await db.execute<SnapshotRow>(sql`
    WITH selected AS (
      SELECT i.*, rs.runner_snapshot
      FROM run_sessions rs
      JOIN run_session_incarnations i ON i.run_session_id = rs.id AND i.run_id = rs.run_id
      WHERE rs.run_id = ${runId} AND ${selectedAttempt}
      ORDER BY (i.state IN ('created','active','checkpointed')) DESC,
        i.created_at DESC NULLS LAST, i.id DESC NULLS LAST
      LIMIT 1
    )
    SELECT i.run_session_id AS "runSessionId", i.id AS "incarnationId",
      to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "bindingObservedAt",
      session_usage.created_run_sequence::text AS "lifecycleSequence",
      GREATEST(u.last_run_sequence, u.compaction_run_sequence)::text AS "contextSequence",
      t.last_run_sequence::text AS "transcriptSequence",
      t.revision::text AS "transcriptRevision",
      u.used_tokens::text AS used, u.size_tokens::text AS size,
      u.observed_at AS "observedAt", u.usage_run_sequence::text AS "usageSequence",
      CASE WHEN i.state IN ('created','active','checkpointed') THEN COALESCE(u.active_compactions,0)
        ELSE 0 END AS "activeCompactions",
      COALESCE(u.completed_compactions,0) AS "completedCompactions",
      session_usage.created_run_sequence IS NOT NULL
        AND NOT session_usage.coverage_incomplete AS "hasCreatedEvent",
      i.runner_snapshot->>'adapter' AS adapter,
      i.runner_snapshot->>'providerKind' AS "providerKind",
      i.runner_snapshot->'env'->>'CLAUDE_CODE_MAX_CONTEXT_TOKENS' AS configured
    FROM (SELECT 1) scope
    LEFT JOIN selected i ON TRUE
    LEFT JOIN run_context_usage u ON u.run_id = i.run_id
      AND u.execution_host_id = i.execution_host_id AND u.assignment_epoch = i.assignment_epoch
      AND u.assignment_id = i.execution_assignment_id AND u.host_session_id = i.host_session_id
      AND ${usageScope}
    LEFT JOIN run_context_usage session_usage ON session_usage.run_id = i.run_id
      AND session_usage.execution_host_id = i.execution_host_id
      AND session_usage.assignment_epoch = i.assignment_epoch
      AND session_usage.assignment_id = i.execution_assignment_id
      AND session_usage.host_session_id = i.host_session_id AND session_usage.node_attempt_id IS NULL
    LEFT JOIN run_context_transcript_revisions t ON t.run_id = ${runId}
      AND ${transcriptScope}
  `);
  const row = result.rows[0];

  return {
    type: "session.context_snapshot",
    runId,
    nodeAttemptId,
    runSessionId: row?.runSessionId ?? null,
    incarnationId: row?.incarnationId ?? null,
    bindingObservedAt: row?.bindingObservedAt ?? null,
    lifecycleSequence: row?.lifecycleSequence ?? null,
    contextSequence: row?.contextSequence ?? null,
    transcriptSequence: row?.transcriptSequence ?? null,
    transcriptRevision: row?.transcriptRevision ?? null,
    usage:
      row?.used != null &&
      row.size != null &&
      row.observedAt &&
      row.usageSequence
        ? {
            used: Number(row.used),
            size: Number(row.size),
            sizeSource: "agent_reported",
            observedAt: new Date(row.observedAt).toISOString(),
            sourceSequence: row.usageSequence,
          }
        : null,
    activeCompactions: row?.activeCompactions ?? 0,
    completedCompactions: row?.completedCompactions ?? 0,
    coverage: row?.hasCreatedEvent ? "from_incarnation_start" : "partial",
    ...claudeContextWindow({
      adapter: row?.adapter ?? null,
      providerKind: row?.providerKind ?? null,
      configured: row?.configured,
    }),
  };
}

export async function readCurrentAttemptId(
  db: Pick<Db, "execute">,
  runId: string,
): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT n.id FROM node_attempts n JOIN runs r ON r.id = n.run_id AND r.current_step_id = n.node_id
    WHERE r.id = ${runId}
    ORDER BY n.attempt DESC, n.id DESC LIMIT 1
  `);

  return result.rows[0]?.id ?? null;
}

export async function contextProjectionThrough(
  db: Pick<Db, "execute">,
  runId: string,
  through: bigint,
): Promise<boolean> {
  if (through < 0n) return true;
  const result = await db.execute<{ ready: boolean }>(sql`
    SELECT count(*) FILTER (WHERE last_run_sequence >= ${through}) = 2 AS ready
    FROM execution_event_consumers WHERE run_id = ${runId} AND consumer_name IN (
      ${CANONICAL_PROJECTION_CONSUMERS.context}, ${CANONICAL_PROJECTION_CONSUMERS.transcript}
    )
  `);

  return result.rows[0]?.ready === true;
}
