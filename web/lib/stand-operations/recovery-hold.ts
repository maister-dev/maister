import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { operationDto } from "./operation-intake";
import { standRecoveryDecisionSchema } from "./operation-types";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { redactQueryError } from "@/lib/db/pg-error";
import {
  standOperations,
  standRecoveryDecisions,
  standResourceClaims,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";

const log = pino({
  name: "stand-recovery-hold",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Retain an operator decision while preserving the unknown effect and its exclusion claim. */
export async function recordStandRecoveryHold(
  db: Db,
  userId: string,
  operationId: string,
  raw: unknown,
): Promise<{ operation: StandOperation; duplicate: boolean }> {
  const parsed = standRecoveryDecisionSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Provide the exact operation revision, recovery decision and reason",
    );
  const input = parsed.data;
  const decisionDigest = contentDigest({ operationId, input });

  try {
    const result = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        companyId,
        "targets:recover",
      );

      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
      const [stored] = await tx
        .select({ operation: standOperations })
        .from(standOperations)
        .innerJoin(standTargets, eq(standTargets.id, standOperations.targetId))
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
          {
            details: { reason: "stand_operation_unavailable" },
          },
        );
      const captured = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        stored.operation.assignmentId,
        stored.operation.inputRevision,
      );
      const [current] = await tx
        .select()
        .from(standOperations)
        .where(eq(standOperations.id, operationId))
        .for("no key update");

      if (!current || current.inputSha256 !== captured.digest)
        throw new MaisterError(
          "CONFLICT",
          "The retained operation input witness is unavailable",
        );
      const [previous] = await tx
        .select({ digest: standRecoveryDecisions.decisionDigest })
        .from(standRecoveryDecisions)
        .where(
          and(
            eq(standRecoveryDecisions.operationId, operationId),
            eq(standRecoveryDecisions.actorId, authority.actor.id),
            eq(standRecoveryDecisions.deliveryKey, input.idempotencyKey),
          ),
        );

      if (previous) {
        if (previous.digest !== decisionDigest)
          throw new MaisterError(
            "CONFLICT",
            "The recovery delivery key already names a different decision",
          );
        const [successor] = await tx
          .select({ id: standOperations.id })
          .from(standOperations)
          .where(eq(standOperations.predecessorId, operationId));

        return {
          operation: operationDto(current, successor?.id),
          duplicate: true,
        };
      }
      if (input.decision !== "hold" || input.inspectionIds.length !== 0)
        throw new MaisterError(
          "CONFLICT",
          "This recovery decision requires authenticated target inspections",
        );

      if (
        current.action !== "restart" ||
        current.revision !== input.expectedRevision ||
        current.effectState !== "unknown"
      )
        throw new MaisterError(
          "CONFLICT",
          "A recovery hold requires the current unknown restart operation",
        );

      const [claim] = await tx
        .select({ unresolved: standResourceClaims.unresolved })
        .from(standResourceClaims)
        .where(
          and(
            eq(standResourceClaims.operationId, operationId),
            eq(standResourceClaims.resourceKey, current.resourceKey),
          ),
        )
        .for("share");

      if (!claim?.unresolved)
        throw new MaisterError(
          "CONFLICT",
          "The unknown restart has no unresolved resource claim",
        );

      const revision = current.revision + 1;

      await tx.insert(standRecoveryDecisions).values({
        operationId,
        operationRevision: revision,
        actorId: authority.actor.id,
        decision: input.decision,
        inspectionIds: input.inspectionIds,
        reason: input.reason,
        authority: authority.witness,
        deliveryKey: input.idempotencyKey,
        decisionDigest,
      });
      const [updated] = await tx
        .update(standOperations)
        .set({ disposition: "unresolved_hold", revision })
        .where(eq(standOperations.id, operationId))
        .returning();

      if (!updated)
        throw new MaisterError(
          "CRASH",
          "The retained operation could not be updated",
        );

      return { operation: operationDto(updated), duplicate: false };
    });

    log.info(
      {
        operationId,
        actorId: userId,
        revision: result.operation.revision,
        duplicate: result.duplicate,
      },
      "stand recovery hold retained",
    );

    return result;
  } catch (error) {
    throw redactQueryError(error);
  }
}
