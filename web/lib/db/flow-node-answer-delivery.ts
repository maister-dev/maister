import "server-only";

import type { SQL, SQLWrapper } from "drizzle-orm";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import pino from "pino";

import { notifyNodeQuestionChanged } from "@/lib/runs/peek-wake";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";

const log = pino({
  name: "flow-node-answer-delivery",
  level: process.env.LOG_LEVEL ?? "info",
});

type DeliveryTarget = {
  questionId: string;
  runId: string;
  commandId: string;
  hostId: string;
};
type QuestionIdentity = {
  schema: SQLWrapper;
  runId: SQLWrapper;
  flowNodeAttemptId: SQLWrapper;
};

// The attempt's current resume pointer can advance before projection. Match
// the original checkpoint and the immutable owner of the successor command.
function matchingSuccessor(q: QuestionIdentity): SQL {
  return sql`
  FROM execution_commands c
  JOIN run_session_incarnations resumed ON resumed.id=c.owner_ref->>'incarnationId'
  JOIN run_session_incarnations source ON source.id=${q.schema}->'flowQuestion'->>'incarnationId'
  WHERE c.kind='session.prompt' AND c.owner_kind='flow_node_attempt' AND c.owner_ref->>'variant'='node'
    AND (c.accepted_at IS NOT NULL OR c.state='succeeded')
    AND c.run_id=${q.runId} AND c.owner_ref->>'runId'=${q.runId}
    AND c.owner_ref->>'nodeAttemptId'=${q.flowNodeAttemptId}
    AND c.owner_ref->'promptOrdinal'=to_jsonb((${q.schema}->'flowQuestion'->>'promptOrdinal')::int+1)
    AND resumed.run_id=${q.runId} AND source.run_id=${q.runId} AND resumed.id<>source.id
    AND resumed.run_session_id=c.owner_ref->>'runSessionId' AND resumed.run_session_id=source.run_session_id
    AND resumed.host_session_id=c.target_session_id AND resumed.acp_session_id=source.acp_session_id
    AND resumed.execution_host_id=c.execution_host_id AND source.execution_host_id=c.execution_host_id
    AND resumed.execution_assignment_id=c.execution_assignment_id AND resumed.assignment_epoch=c.assignment_epoch
    AND c.owner_ref->>'assignmentId'=c.execution_assignment_id
    AND c.owner_ref->>'assignmentEpoch'=c.assignment_epoch::text
    AND source.execution_assignment_id=${q.schema}->'flowQuestion'->>'assignmentId'
    AND source.assignment_epoch<c.assignment_epoch
  `;
}

export function acceptedFlowNodeSuccessorExists(
  question: QuestionIdentity,
): SQL {
  return sql`EXISTS (SELECT 1 ${matchingSuccessor(question)})`;
}

const aliasedQuestion = {
  schema: sql`q.schema`,
  runId: sql`q.run_id`,
  flowNodeAttemptId: sql`q.flow_node_attempt_id`,
};
const awaitingDelivery = sql`q.flow_answer_accepted_at IS NOT NULL AND q.responded_at IS NULL AND q.superseded_at IS NULL`;

async function projectDeliveries(db: Db, scope: SQL): Promise<number> {
  const { rows } = await db.execute<DeliveryTarget>(sql`
    SELECT q.id AS "questionId", q.run_id AS "runId", match.*
    FROM hitl_requests q
    JOIN LATERAL (
      SELECT c.id AS "commandId", c.execution_host_id AS "hostId" ${matchingSuccessor(aliasedQuestion)}
      ORDER BY c.created_at,c.id LIMIT 1
    ) match ON true
    WHERE ${awaitingDelivery} AND ${scope}
  `);
  let delivered = 0;

  for (const target of rows) {
    try {
      const applied = await db.transaction(async (tx) => {
        const owner = await tx.execute(
          sql`SELECT id FROM runs WHERE id=${target.runId} FOR NO KEY UPDATE SKIP LOCKED`,
        );

        if (!owner.rows.length) return false;
        const { rows: updated } = await tx.execute<{ step_id: string }>(sql`
          UPDATE hitl_requests q SET responded_at=clock_timestamp()
          WHERE q.id=${target.questionId} AND ${awaitingDelivery}
          RETURNING q.step_id
        `);
        const question = updated[0];

        if (!question) return false;
        await appendManagerRunStreamEvent(tx, {
          runId: target.runId,
          sourceKey: `flow-node-question:${target.questionId}:delivered`,
          event: {
            type: "hitl.responded",
            data: {
              hitlRequestId: target.questionId,
              nodeId: question.step_id,
              state: "delivered",
            },
          },
        });
        await notifyNodeQuestionChanged(tx, target.runId);

        return true;
      });

      if (applied) {
        delivered++;
        log.info(target, "Host accepted the answered node prompt");
      }
    } catch (error) {
      log.warn(
        { ...target, err: error },
        "Flow question delivery projection deferred",
      );
    }
  }

  return delivered;
}

export async function projectCommittedFlowNodeAnswers(
  db: Db,
  runId: string,
  commandIds: readonly string[],
): Promise<void> {
  if (!commandIds.length) return;
  try {
    await projectDeliveries(
      db,
      sql`q.run_id=${runId} AND match."commandId" IN (${sql.join(
        commandIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  } catch (error) {
    log.warn(
      { runId, commandIds, err: error },
      "Flow question delivery projection deferred",
    );
  }
}

export async function recoverPersistedFlowNodeAnswers(db: Db): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(sql`
    WITH pending AS (
      SELECT q.id FROM hitl_requests q WHERE ${awaitingDelivery}
        AND (q.flow_reconciled_at IS NULL OR q.flow_reconciled_at<clock_timestamp()-interval '10 seconds')
        AND ${acceptedFlowNodeSuccessorExists(aliasedQuestion)}
      ORDER BY q.flow_reconciled_at NULLS FIRST,q.created_at,q.id
      LIMIT 30 FOR UPDATE SKIP LOCKED
    ) UPDATE hitl_requests q SET flow_reconciled_at=clock_timestamp()
      FROM pending WHERE q.id=pending.id RETURNING q.id
  `);

  if (!rows.length) return 0;

  return projectDeliveries(
    db,
    sql`q.id IN (${sql.join(
      rows.map(({ id }) => sql`${id}`),
      sql`, `,
    )})`,
  );
}
