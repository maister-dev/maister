import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ChainDepth } from "./chain-depth";

import { and, eq, gt, sql } from "drizzle-orm";
import pino from "pino";

import {
  claimEventAgentAttempt,
  settleCompanyAgentTriggerAttempt,
} from "./trigger-attempts";
import { resolveCompanyEventChainDepth } from "./chain-depth";
import { companyTriggerBindingSnapshotSchema } from "./trigger-attempt-types";

import { agentSchedules, runs } from "@/lib/db/schema";
import { isAgentTriggerEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { reserveCompanyEventAssignment } from "@/lib/specialist-assignments/company-event-intake";
import { wakePendingSpecialistAssignment } from "@/lib/specialist-assignments/admission-wake";

const log = pino({
  name: "company-event-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Compose with the registered event consumer; keyset batches do not drop subscriptions when fanout exceeds one batch. */
export async function dispatchCompanyAgentEvents(
  db: Db,
  events: readonly DomainEventRow[],
): Promise<void> {
  for (const event of events) {
    if (
      typeof event.companyId !== "string" ||
      event.projectId !== null ||
      !isAgentTriggerEventKind(event.kind)
    )
      continue;
    const [producing] =
      event.runId === null
        ? []
        : await db
            .select({ sourceAgentId: runs.sourceAgentId })
            .from(runs)
            .where(
              and(
                eq(runs.id, event.runId),
                eq(runs.companyId, event.companyId),
              ),
            );
    let cursor: string | null = null;
    let chain: ChainDepth | null = null;

    while (true) {
      const sources = await db
        .select()
        .from(agentSchedules)
        .where(
          and(
            eq(agentSchedules.companyId, event.companyId),
            sql`${agentSchedules.projectId} IS NULL`,
            eq(agentSchedules.triggerType, "event"),
            eq(agentSchedules.enabled, true),
            sql`${agentSchedules.createdAt} <= (SELECT created_at FROM domain_events WHERE id=${event.id})`,
            cursor === null ? undefined : gt(agentSchedules.id, cursor),
          ),
        )
        .orderBy(agentSchedules.id)
        .limit(25);

      if (sources.length === 0) break;
      cursor = sources[sources.length - 1]!.id;
      for (const source of sources) {
        const now = new Date();
        let claim: Awaited<ReturnType<typeof claimEventAgentAttempt>>;

        try {
          const kinds =
            companyTriggerBindingSnapshotSchema.shape.eventKinds.safeParse(
              source.eventMatch?.kinds,
            );

          if (!kinds.success || kinds.data.length === 0)
            throw new MaisterError(
              "CONFIG",
              "Company event source kinds must be a nonempty validated list",
              {
                details: { reason: "company_event_source_kinds_invalid" },
              },
            );
          if (!kinds.data.includes(event.kind)) continue;
          claim = await claimEventAgentAttempt(db, source.id, now, event.id);
        } catch (error) {
          if (!isMaisterError(error)) throw error;
          await db
            .update(agentSchedules)
            .set({
              lastOutcome: "refused",
              lastErrorCode: error.code,
              lastErrorMessage:
                "Company event source capture requires attention",
              updatedAt: now,
            })
            .where(
              and(
                eq(agentSchedules.id, source.id),
                eq(
                  agentSchedules.companyConfigRevision,
                  source.companyConfigRevision!,
                ),
              ),
            );
          log.warn(
            {
              sourceId: source.id,
              eventId: event.id,
              companyId: event.companyId,
              code: error.code,
            },
            "company event source capture refused",
          );
          continue;
        }
        if (!claim) continue;
        const selfAuthored =
          (event.actorType === "agent" && event.actorId === source.agentId) ||
          producing?.sourceAgentId === source.agentId;

        if (!selfAuthored)
          chain ??= await resolveCompanyEventChainDepth(db, event.id);
        if (selfAuthored || chain?.atCap) {
          await settleCompanyAgentTriggerAttempt(db, claim, {
            outcome: "suppressed",
            runId: null,
            reasonCode: selfAuthored
              ? "self_authored_event"
              : (chain?.reason ?? "chain_depth_exhausted"),
            now,
          });
          continue;
        }
        let receipt: Awaited<ReturnType<typeof reserveCompanyEventAssignment>>;

        try {
          receipt = await reserveCompanyEventAssignment(db, {
            attemptId: claim.id,
            runId: claim.reservedRunId,
          });
          await settleCompanyAgentTriggerAttempt(db, claim, {
            outcome: receipt.duplicate ? "deduplicated" : "queued",
            runId: claim.reservedRunId,
            reasonCode: null,
            now,
          });
        } catch (error) {
          await settleCompanyAgentTriggerAttempt(db, claim, {
            outcome: isMaisterError(error) ? "refused" : "failed",
            runId: null,
            reasonCode: isMaisterError(error) ? error.code : "CRASH",
            now,
          });
          log.warn(
            {
              sourceId: source.id,
              eventId: event.id,
              companyId: event.companyId,
              attemptId: claim.id,
              code: isMaisterError(error) ? error.code : "CRASH",
              reason:
                isMaisterError(error) &&
                typeof error.details?.reason === "string"
                  ? error.details.reason
                  : null,
              ...queryErrorDiagnostics(error),
            },
            "company event admission refused",
          );
          continue;
        }
        await wakePendingSpecialistAssignment(db, receipt);
      }
    }
  }
}
