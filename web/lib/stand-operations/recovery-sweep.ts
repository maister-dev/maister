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

/** The system sweep adopts existing receipts. It never submits a restart. */
export async function recoverInterruptedStandOperations(
  db: Db,
): Promise<{ scanned: number; settled: number; pending: number }> {
  const candidates = (
    await db.execute(sql`
    SELECT operation.id,operation.initiating_user_id,operation.revision
    FROM stand_operations operation
    JOIN stand_resource_claims resource ON resource.operation_id=operation.id
      AND resource.canonical_resource_key=operation.resource_key AND resource.unresolved
    JOIN stand_targets target ON target.id=operation.target_id AND target.enabled
      AND target.config_revision=operation.config_revision
    JOIN company_grants grant_row ON grant_row.company_id=target.company_id
      AND grant_row.principal_type='user' AND grant_row.principal_id=operation.initiating_user_id
      AND grant_row.action='targets:recover' AND grant_row.revoked_at IS NULL
    LEFT JOIN stand_read_claims reader ON reader.operation_id=operation.id AND reader.purpose='reconcile'
    WHERE operation.action='restart' AND operation.effect_state IN ('dispatching','unknown')
      AND operation.disposition='pending' AND resource.expires_at<=clock_timestamp()
      AND (reader.expires_at IS NULL OR reader.expires_at<=clock_timestamp()-interval '30 seconds')
    ORDER BY reader.expires_at NULLS FIRST,operation.created_at,operation.id
    LIMIT ${maximumCandidates}
  `)
  ).rows;
  let settled = 0;
  let pending = 0;

  await Promise.all(
    candidates.map(async ({ id, initiating_user_id, revision }) => {
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
            code: isMaisterError(error) ? error.code : "CRASH",
          },
          "stand receipt recovery remains pending",
        );
      }
    }),
  );

  return { scanned: candidates.length, settled, pending };
}
