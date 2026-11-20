import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type { CompanyEventScheduleReceipt } from "./company-schedule-types";

import { sql } from "drizzle-orm";

import { companyEventScheduleInputSchema } from "./company-schedule-types";
import { createCompanyScheduleSource } from "./company-source-creation";

import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

/** Retain a reviewed native event subscription without retaining raw event payload or recurring request text. */
export async function createCompanyEventSchedule(
  db: SqlDatabase,
  userId: string,
  request: unknown,
): Promise<CompanyEventScheduleReceipt> {
  const parsed = companyEventScheduleInputSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company event source request is invalid",
    );
  const input = {
    ...parsed.data,
    eventKinds: [...parsed.data.eventKinds].sort(),
  };
  const digest = contentDigest(input);

  return createCompanyScheduleSource(
    db,
    userId,
    input,
    digest,
    "domain_event",
    async (tx, context) => {
      if (input.enabled && context.role.installationGrant) {
        if (!context.role.installationGrant.scopes.includes("runs:read"))
          throw new MaisterError(
            "UNAUTHORIZED",
            "Enabled installation event work requires the reviewed runs:read scope",
          );
      } else if (input.enabled) {
        const grant = (
          await tx.execute(
            sql`SELECT id FROM company_grants WHERE company_id=${input.owner.companyId} AND principal_type='agent' AND principal_id=${context.role.agentId} AND action='assignments:read' AND revoked_at IS NULL FOR SHARE`,
          )
        ).rows[0];

        if (!context.role.grantActions.includes("assignments:read") || !grant)
          throw new MaisterError(
            "UNAUTHORIZED",
            "Enabled company event work requires the responsible specialist's reviewed assignments:read limit and current company grant",
            {
              details: { reason: "company_event_source_sharing_required" },
            },
          );
      }
      await tx.execute(
        sql`INSERT INTO agent_schedules(id,agent_id,project_id,company_id,company_specialist_binding_id,company_flow_binding_id,company_config_revision,created_by,installation_review,creation_key,creation_digest,trigger_type,event_match,enabled) VALUES(${context.sourceId},${context.role.agentId},NULL,${input.owner.companyId},${input.specialistBindingId},${input.coordinatorFlowBindingId},1,${context.actorId},${context.installationReview}::jsonb,${input.idempotencyKey},${digest},'event',${JSON.stringify({ kinds: input.eventKinds })}::jsonb,${input.enabled})`,
      );
    },
  );
}
