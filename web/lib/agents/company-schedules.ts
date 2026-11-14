import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type {
  CompanyCronScheduleInput,
  CompanyCronScheduleReceipt,
} from "./company-schedule-types";

import { sql } from "drizzle-orm";

import { createCompanyScheduleSource } from "./company-source-creation";
import { companyCronScheduleInputSchema } from "./company-schedule-types";
import { normalizeScheduledRequest } from "./scheduled-request";

import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { resolveScheduledStandInspection } from "@/lib/stand-operations/scheduled-inspection";
import { nextFireAt } from "@/lib/run-schedules/cron";

/** Retain the original cron recipe and immutable receipt; actual dispatch rechecks current authority. */
export async function createCompanyCronSchedule(
  db: SqlDatabase,
  userId: string,
  request: CompanyCronScheduleInput,
): Promise<CompanyCronScheduleReceipt> {
  const parsed = companyCronScheduleInputSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company cron source request is invalid",
    );
  const input = {
    ...parsed.data,
    requestAtLaunch: normalizeScheduledRequest(parsed.data.requestAtLaunch),
  };
  const digest = contentDigest(input);

  return createCompanyScheduleSource(
    db,
    userId,
    input,
    digest,
    "cron",
    async (tx, context) => {
      if (input.enabled && input.requestAtLaunch === null)
        throw new MaisterError(
          "NEEDS_INPUT",
          "Company scheduled work requires an explicit retained recurring request",
          {
            details: { reason: "company_scheduled_request_missing" },
          },
        );
      const selector = input.standInspection;
      if (
        selector &&
        (context.role.definition.kind !== "operational" ||
          context.role.definition.completion?.contract !==
            "operational_evidence_v2" ||
          context.role.definition.riskTier !== "read_only" ||
          !context.role.definition.specialist?.targetClasses.includes(
            "stand",
          ) ||
          !context.role.grantActions.includes("targets:read") ||
          context.role.grantActions.includes("targets:restart"))
      )
        throw new MaisterError(
          "PRECONDITION",
          "A scheduled inspection requires a reviewed read-only stand specialist",
          {
            details: { reason: "stand_specialist_unavailable" },
          },
        );
      const inspection = selector
        ? await resolveScheduledStandInspection(
            tx,
            userId,
            input.owner.companyId,
            selector,
          )
        : null;
      const next = nextFireAt(input.cronExpr, input.timezone, new Date());

      await tx.execute(
        sql`INSERT INTO agent_schedules(id,agent_id,project_id,company_id,company_specialist_binding_id,company_flow_binding_id,company_config_revision,created_by,creation_key,creation_digest,trigger_type,request_at_launch,cron_expr,timezone,next_fire_at,enabled,stand_inspection) VALUES(${context.sourceId},${context.role.agentId},NULL,${input.owner.companyId},${input.specialistBindingId},${input.coordinatorFlowBindingId},1,${context.actorId},${input.idempotencyKey},${digest},'cron',${input.requestAtLaunch},${input.cronExpr},${input.timezone},${next},${input.enabled},${inspection ? JSON.stringify(inspection.appointment) : null}::jsonb)`,
      );
    },
  );
}
