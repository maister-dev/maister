import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { StandInspectionSelector } from "./scheduled-inspection-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { standComponentSchema } from "./target-types";
import { MaisterError } from "@/lib/errors";

const scheduledComponent = z.object({
  config_revision: z.number().int().positive(),
  incarnation_id: z.uuid(),
  config: standComponentSchema,
  runbook_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Resolve the current configured component, check read authority, and retain the reviewed version. */
export async function resolveScheduledStandInspection(
  tx: SqlTransaction,
  userId: string,
  companyId: string,
  selector: StandInspectionSelector,
) {
  await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
  const [row] = (
    await tx.execute(sql`
    SELECT target.config_revision,target.incarnation_id,part.config,part.runbook_sha256
    FROM stand_targets target JOIN stand_components part
      ON part.target_id=target.id AND part.config_revision=target.config_revision
    WHERE target.id=${selector.targetId} AND target.company_id=${companyId}
      AND target.enabled AND part.component_id=${selector.componentId}
    FOR SHARE OF target
  `)
  ).rows;
  const current = scheduledComponent.safeParse(row);
  if (!current.success || !current.data.config.actions.includes("inspect"))
    throw new MaisterError(
      "PRECONDITION",
      "The scheduled stand component does not allow inspection",
      {
        details: { reason: "stand_target_unavailable" },
      },
    );
  const runbook = current.data.config.runbook;
  if (
    (await readStandRunbookDigest(tx, userId, companyId, runbook)) !==
    current.data.runbook_sha256
  )
    throw new MaisterError(
      "PRECONDITION",
      "The scheduled stand runbook witness has changed",
      {
        details: { reason: "knowledge_reference_unavailable" },
      },
    );
  return {
    appointment: {
      targetId: selector.targetId,
      componentId: selector.componentId,
      configRevision: current.data.config_revision,
      incarnationId: current.data.incarnation_id,
    },
    runbook,
  };
}
