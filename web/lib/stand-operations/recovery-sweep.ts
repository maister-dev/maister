import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import pino from "pino";

import { reconcileStandRestart } from "./reconcile";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "stand-recovery-sweep",
  level: process.env.LOG_LEVEL ?? "info",
});
const maximumCandidates = 3;
/** First retry after 30 s, doubling per unsettled attempt up to 30 minutes. */
const backoffBaseSeconds = 30;
const backoffMaximumSeconds = 1800;

/**
 * The system sweep adopts existing receipts. It never submits a restart.
 *
 * Every selected candidate is stamped in `stand_recovery_attempts` before its
 * reconciliation runs, so a candidate whose current authority or input access
 * refuses the read (which writes no read claim) backs off instead of pinning
 * the bounded head forever and starving newer unknown restarts.
 */
export async function recoverInterruptedStandOperations(
  db: Db,
): Promise<{ scanned: number; settled: number; pending: number }> {
  const candidates = (
    await db.execute(sql`
    WITH due AS (
      SELECT operation.id,operation.initiating_user_id,operation.revision,
        attempt.next_attempt_at,operation.created_at
      FROM stand_operations operation
      JOIN stand_resource_claims resource ON resource.operation_id=operation.id
        AND resource.canonical_resource_key=operation.resource_key AND resource.unresolved
      JOIN stand_targets target ON target.id=operation.target_id AND target.enabled
        AND target.config_revision=operation.config_revision
      JOIN company_grants grant_row ON grant_row.company_id=target.company_id
        AND grant_row.principal_type='user' AND grant_row.principal_id=operation.initiating_user_id
        AND grant_row.action='targets:recover' AND grant_row.revoked_at IS NULL
      LEFT JOIN stand_read_claims reader ON reader.operation_id=operation.id AND reader.purpose='reconcile'
      LEFT JOIN stand_recovery_attempts attempt ON attempt.operation_id=operation.id
      WHERE operation.action='restart' AND operation.effect_state IN ('dispatching','unknown')
        AND operation.disposition='pending' AND resource.expires_at<=clock_timestamp()
        AND (reader.expires_at IS NULL OR reader.expires_at<=clock_timestamp()-interval '30 seconds')
        AND (attempt.next_attempt_at IS NULL OR attempt.next_attempt_at<=clock_timestamp())
      ORDER BY attempt.next_attempt_at NULLS FIRST,operation.created_at,operation.id
      LIMIT ${maximumCandidates}
    ), stamped AS (
      INSERT INTO stand_recovery_attempts AS attempt(operation_id,attempts,last_attempt_at,next_attempt_at)
      SELECT due.id,1,clock_timestamp(),clock_timestamp()+make_interval(secs=>${backoffBaseSeconds}) FROM due
      ON CONFLICT (operation_id) DO UPDATE SET
        attempts=LEAST(attempt.attempts+1,2147483647),
        last_attempt_at=clock_timestamp(),
        next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(
          ${backoffMaximumSeconds}::double precision,
          ${backoffBaseSeconds}::double precision*power(2,LEAST(attempt.attempts,16))))
      RETURNING operation_id,attempts
    )
    SELECT due.id,due.initiating_user_id,due.revision,stamped.attempts
    FROM due JOIN stamped ON stamped.operation_id=due.id
    ORDER BY due.next_attempt_at NULLS FIRST,due.created_at,due.id
  `)
  ).rows;
  let settled = 0;
  let pending = 0;

  await Promise.all(
    candidates.map(async ({ id, initiating_user_id, revision, attempts }) => {
      if (
        typeof id !== "string" ||
        typeof initiating_user_id !== "string" ||
        typeof revision !== "number"
      ) {
        pending++;
        log.error(
          { code: "CRASH" },
          "invalid retained stand recovery candidate",
        );

        return;
      }
      try {
        const result = await reconcileStandRestart(
          db,
          initiating_user_id,
          id,
          { expectedRevision: revision },
          { kind: "scheduler" },
        );

        if (
          result.effectState === "confirmed_applied" ||
          result.effectState === "confirmed_not_applied"
        )
          settled++;
        else pending++;
      } catch (error) {
        pending++;
        log.warn(
          {
            operationId: id,
            attempts,
            code: isMaisterError(error) ? error.code : "CRASH",
          },
          "[FIX:stand-sweep-starvation] stand receipt recovery remains pending; candidate backed off",
        );
      }
    }),
  );

  return { scanned: candidates.length, settled, pending };
}
