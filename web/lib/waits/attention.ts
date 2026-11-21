import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { WaitConditionKind } from "@/lib/waits/contracts";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  flowRevisions,
  flows,
  hitlRequests,
  nodeAttempts,
  runs,
  runWaits,
} from "@/lib/db/schema";

export type OpenWaitLabel = { kind: WaitConditionKind; name: string | null };

export async function getOpenWaitLabels(
  db: Db,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, OpenWaitLabel>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([runWaits.runId], {
      runId: runWaits.runId,
      kind: runWaits.conditionKind,
      name: sql<string | null>`${runWaits.condition}->'parameters'->>'name'`,
    })
    .from(runWaits)
    .where(and(inArray(runWaits.runId, runIds), eq(runWaits.state, "open")))
    .orderBy(runWaits.runId, desc(runWaits.openedAt), desc(runWaits.id));

  return new Map(rows.map(({ runId, ...label }) => [runId, label]));
}

export async function listWaitDecisions(db: Db, projectIds: readonly string[]) {
  if (!projectIds.length) return [];
  const nodes = sql`coalesce(${flowRevisions.manifest}, ${flows.manifest})->'nodes'`;

  return db
    .selectDistinctOn([runWaits.runId], {
      waitId: runWaits.id,
      projectId: runWaits.projectId,
      runId: runWaits.runId,
      taskId: runs.taskId,
      since: runWaits.deadlineAt,
      reason: sql<
        "overdue" | "timeout_handoff"
      >`CASE WHEN ${runWaits.state}='open' THEN 'overdue' ELSE 'timeout_handoff' END`,
    })
    .from(runWaits)
    .innerJoin(runs, eq(runs.id, runWaits.runId))
    .leftJoin(nodeAttempts, eq(nodeAttempts.id, runWaits.nodeAttemptId))
    .leftJoin(flowRevisions, eq(flowRevisions.id, runs.flowRevisionId))
    .leftJoin(flows, eq(flows.id, runs.flowId))
    .where(
      and(
        inArray(runWaits.projectId, projectIds),
        sql`NOT EXISTS (SELECT 1 FROM ${hitlRequests} h WHERE h.run_id=${runs.id}
        AND h.responded_at IS NULL AND h.superseded_at IS NULL
        AND h.activation_state IS DISTINCT FROM 'failed')`,
        sql`(
        (${runWaits.state}='open' AND ${runs.status}='Waiting' AND ${runWaits.deadlineAt} <= statement_timestamp())
        OR (${runWaits.state}='resolved' AND ${runWaits.result}->>'outcome'='timeout'
          AND ${runs.status} IN ('Pending','Running')
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(${nodes}) AS wait_node(value)
            JOIN jsonb_array_elements(${nodes}) AS next_node(value)
              ON next_node.value->>'id'=wait_node.value->'transitions'->>'timeout'
            WHERE wait_node.value->>'id'=${nodeAttempts.nodeId} AND next_node.value->>'type' IN ('human','form')
              AND (${runWaits.resumeState} IN ('admitted','queued')
                OR (${runWaits.resumeState}='applied' AND ${runs.currentStepId}=next_node.value->>'id'))
          )
        )
      )`,
      ),
    )
    .orderBy(runWaits.runId, desc(runWaits.deadlineAt), desc(runWaits.id));
}
