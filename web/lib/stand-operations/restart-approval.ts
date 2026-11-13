import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { standRestartApprovalSchema } from "./operation-types";
import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import {
  specialistAssignments,
  standComponents,
  standOperations,
  standRestartApprovals,
  standTargets,
} from "@/lib/db/schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";

const log = pino({
  name: "stand-restart-approval",
  level: process.env.LOG_LEVEL ?? "info",
});

export type StandRestartApproval = Readonly<{
  operationId: string;
  requestDigest: string;
  operationRevision: number;
  approvedBy: string;
  approvedAt: string;
}>;

function approvalDto(
  row: typeof standRestartApprovals.$inferSelect,
): StandRestartApproval {
  return {
    operationId: row.operationId,
    requestDigest: row.requestDigest,
    operationRevision: row.operationRevision,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt.toISOString(),
  };
}

/** A current human decision approves the original intent and cannot change its target or input. */
export async function approveStandRestart(
  db: Db,
  userId: string,
  operationId: string,
  raw: unknown,
): Promise<{ approval: StandRestartApproval; duplicate: boolean }> {
  const parsed = standRestartApprovalSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Provide the exact operation revision and intent digest to approve a restart",
    );
  const input = parsed.data;
  const approvalDigest = contentDigest({ operationId, input });

  try {
    const result = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        companyId,
        "targets:restart",
      );

      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
      const [stored] = await tx
        .select({
          operation: standOperations,
          target: standTargets,
          component: standComponents,
        })
        .from(standOperations)
        .innerJoin(standTargets, eq(standTargets.id, standOperations.targetId))
        .innerJoin(
          standComponents,
          and(
            eq(standComponents.targetId, standOperations.targetId),
            eq(standComponents.configRevision, standOperations.configRevision),
            eq(standComponents.componentId, standOperations.componentId),
          ),
        )
        .where(
          and(
            eq(standOperations.id, operationId),
            eq(standTargets.companyId, companyId),
          ),
        );

      if (!stored)
        throw new MaisterError(
          "PRECONDITION",
          "The retained stand operation is unavailable",
          { details: { reason: "stand_operation_unavailable" } },
        );
      const { operation, target, component } = stored;
      const [head] = await tx
        .select({
          inputRevision: specialistAssignments.inputRevision,
          status: specialistAssignments.status,
        })
        .from(specialistAssignments)
        .where(eq(specialistAssignments.id, operation.assignmentId))
        .for("share");
      const captured = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        operation.assignmentId,
        operation.inputRevision,
      );
      const [current] = await tx
        .select()
        .from(standOperations)
        .where(eq(standOperations.id, operation.id))
        .for("no key update");
      const [configuration] = await tx
        .select()
        .from(standTargets)
        .where(eq(standTargets.id, target.id))
        .for("share");

      if (
        !current ||
        !configuration?.enabled ||
        configuration.configRevision !== operation.configRevision ||
        current.action !== "restart" ||
        current.effectState !== "not_dispatched" ||
        current.revision !== input.expectedRevision ||
        current.requestDigest !== input.requestDigest ||
        head?.inputRevision !== operation.inputRevision ||
        captured.digest !== operation.inputSha256 ||
        ["completed", "failed", "cancelled"].includes(head.status)
      )
        throw new MaisterError(
          "CONFLICT",
          "Restart approval requires the exact current undispatched intent and configuration",
        );
      const [existing] = await tx
        .select()
        .from(standRestartApprovals)
        .where(eq(standRestartApprovals.operationId, operation.id));

      if (existing) {
        if (
          existing.approvedBy !== userId ||
          existing.approvalDigest !== approvalDigest
        )
          throw new MaisterError(
            "CONFLICT",
            "A decision is already retained for this exact restart intent",
          );

        return { approval: approvalDto(existing), duplicate: true };
      }
      if (
        (await readStandRunbookDigest(
          tx,
          userId,
          companyId,
          component.config.runbook,
        )) !== component.runbookSha256
      )
        throw new MaisterError(
          "CONFLICT",
          "The configured runbook witness has changed",
        );
      const [approval] = await tx
        .insert(standRestartApprovals)
        .values({
          operationId: operation.id,
          approvedBy: authority.actor.id,
          requestDigest: current.requestDigest,
          operationRevision: current.revision,
          approvalDigest,
          deliveryKey: input.idempotencyKey,
          reason: input.reason,
          authority: authority.witness,
        })
        .returning();

      if (!approval)
        throw new MaisterError("CRASH", "Restart approval was not retained");

      return { approval: approvalDto(approval), duplicate: false };
    });

    log.info(
      {
        operationId,
        approvedBy: userId,
        requestDigest: input.requestDigest,
        duplicate: result.duplicate,
      },
      "stand restart approval retained",
    );

    return result;
  } catch (error) {
    throw redactQueryError(error);
  }
}
