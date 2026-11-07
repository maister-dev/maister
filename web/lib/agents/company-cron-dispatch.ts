import "server-only";

import type { SpecialistIntakeReceipt } from "@/lib/specialist-assignments/intake-types";
import type { Db } from "@/lib/execution-host/db";

import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import pino from "pino";

import {
  claimCronAgentAttempt,
  settleCompanyAgentTriggerAttempt,
} from "./trigger-attempts";

import { agentSchedules } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { nextFireAt } from "@/lib/run-schedules/cron";
import { reserveCompanyCronAssignment } from "@/lib/specialist-assignments/company-cron-intake";
import { wakePendingSpecialistAssignment } from "@/lib/specialist-assignments/admission-wake";
import { isMaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "company-cron-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});
const SOURCE_RETRY_DELAY_MS = 300000;

export type CompanyCronTickSummary = {
  due: number;
  claimed: number;
  launched: number;
  queued: number;
  refused: number;
};

/** Company sources use their own bounded selection in the existing tick, so project due rows cannot starve them. */
export async function dispatchCompanyCronSchedules(
  input: { db?: Db; now?: Date } = {},
): Promise<CompanyCronTickSummary> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const due = await db
    .select()
    .from(agentSchedules)
    .where(
      and(
        isNotNull(agentSchedules.companyId),
        sql`${agentSchedules.projectId} IS NULL`,
        eq(agentSchedules.triggerType, "cron"),
        eq(agentSchedules.enabled, true),
        lte(agentSchedules.nextFireAt, now),
      ),
    )
    .orderBy(agentSchedules.nextFireAt, agentSchedules.id)
    .limit(25);
  const summary = {
    due: due.length,
    claimed: 0,
    launched: 0,
    queued: 0,
    refused: 0,
  };

  for (const source of due) {
    let attempt: Awaited<ReturnType<typeof claimCronAgentAttempt>>;

    try {
      const next = nextFireAt(source.cronExpr!, source.timezone!, now);

      attempt = await claimCronAgentAttempt(db, source.id, now, next);
    } catch (error) {
      if (
        !isMaisterError(error) ||
        !["CONFIG", "PRECONDITION", "CONFLICT"].includes(error.code)
      )
        throw error;
      // This is a bounded retry of a refused source capture, not a fabricated fire
      // or substitute cron expression. A repaired configuration wins the CAS.
      await db
        .update(agentSchedules)
        .set({
          nextFireAt: new Date(now.getTime() + SOURCE_RETRY_DELAY_MS),
          lastOutcome: "refused",
          lastErrorCode: error.code,
          lastErrorMessage: "Company source capture requires attention",
          updatedAt: now,
        })
        .where(
          and(
            eq(agentSchedules.id, source.id),
            eq(
              agentSchedules.companyConfigRevision,
              source.companyConfigRevision!,
            ),
            eq(agentSchedules.enabled, true),
            lte(agentSchedules.nextFireAt, now),
          ),
        );
      summary.refused++;
      log.warn(
        { sourceId: source.id, companyId: source.companyId, code: error.code },
        "company source capture refused; bounded retry retained",
      );
      continue;
    }
    if (!attempt) continue;
    summary.claimed++;
    let receipt: SpecialistIntakeReceipt;

    try {
      receipt = await reserveCompanyCronAssignment(db, {
        attemptId: attempt.id,
        runId: attempt.reservedRunId,
      });

      await settleCompanyAgentTriggerAttempt(db, attempt, {
        outcome: receipt.duplicate ? "deduplicated" : "queued",
        runId: attempt.reservedRunId,
        reasonCode: null,
        now,
      });
    } catch (error) {
      // Settlement adopts a committed exact Run if the response was lost; it
      // never repeats reservation or an external operation to guess the outcome.
      await settleCompanyAgentTriggerAttempt(db, attempt, {
        outcome: isMaisterError(error) ? "refused" : "failed",
        runId: null,
        reasonCode: isMaisterError(error) ? error.code : "CRASH",
        now,
      });
      summary.refused++;
      log.warn(
        {
          sourceId: source.id,
          companyId: source.companyId,
          attemptId: attempt.id,
          code: isMaisterError(error) ? error.code : "CRASH",
          ...queryErrorDiagnostics(error),
        },
        "company cron admission refused",
      );
      continue;
    }
    summary.queued++;
    await wakePendingSpecialistAssignment(db, receipt);
  }
  log.info(summary, "company cron dispatch completed");

  return summary;
}
