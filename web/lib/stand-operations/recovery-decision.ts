import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { operationDto } from "./operation-intake";
import { standRecoveryDecisionSchema } from "./operation-types";
import {
  readStandReceiptIds,
  readStandVerificationIds,
} from "./receipt-queries";
import {
  retainStandSuccessor,
  transferStandResource,
} from "./recovery-successor";

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
  lockSpecialistAssignment,
} from "@/lib/specialist-assignments/store";

const log = pino({
  name: "stand-recovery-decision",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Retain a human decision and preserve the unknown effect across the resource transition. */
export async function recordStandRecoveryDecision(
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stand-recovery:${operationId}`},0))`,
      );
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

      if (!previous && input.decision === "authorize_successor")
        await lockSpecialistAssignment(
          tx,
          input.successor.assignmentId,
          input.successor.expectedRevision,
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
      if (previous) {
        if (previous.digest !== decisionDigest)
          throw new MaisterError(
            "CONFLICT",
            "The recovery delivery key already names a different decision",
          );
        const [successor] = await tx
          .select()
          .from(standOperations)
          .where(eq(standOperations.predecessorId, operationId));

        if (successor) {
          await authorizeCompanyUserAction(
            tx,
            userId,
            companyId,
            "targets:restart",
          );
          await getSpecialistAssignmentInputInTransaction(
            tx,
            userId,
            successor.assignmentId,
            successor.inputRevision,
          );
        }

        return {
          operation: operationDto(
            current,
            successor?.id,
            await readStandReceiptIds(tx, operationId),
            await readStandVerificationIds(tx, operationId),
          ),
          duplicate: true,
        };
      }
      if (
        current.action !== "restart" ||
        current.revision !== input.expectedRevision ||
        current.effectState !== "unknown" ||
        current.disposition === "authorized_successor"
      )
        throw new MaisterError(
          "CONFLICT",
          "A recovery decision requires the current unknown restart operation",
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
      const successor =
        input.decision === "authorize_successor"
          ? await retainStandSuccessor(tx, current, companyId, userId, input)
          : null;

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
        .set({
          disposition: successor ? "authorized_successor" : "unresolved_hold",
          revision,
        })
        .where(eq(standOperations.id, operationId))
        .returning();

      if (!updated)
        throw new MaisterError(
          "CRASH",
          "The retained operation could not be updated",
        );

      if (successor) await transferStandResource(tx, current, successor);

      return {
        operation: operationDto(
          updated,
          successor?.id,
          await readStandReceiptIds(tx, operationId),
          await readStandVerificationIds(tx, operationId),
        ),
        duplicate: false,
      };
    });

    log.info(
      {
        operationId,
        actorId: userId,
        decision: input.decision,
        revision: result.operation.revision,
        duplicate: result.duplicate,
      },
      "stand recovery decision retained",
    );

    return result;
  } catch (error) {
    throw redactQueryError(error);
  }
}
