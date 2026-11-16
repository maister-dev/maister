import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation, StandTargetReceipt } from "./operation-types";

import { and, eq } from "drizzle-orm";

import { operationDto } from "./operation-intake";
import { standTargetReceiptSchema } from "./operation-types";
import {
  readStandReceiptIds,
  readStandVerificationIds,
} from "./receipt-queries";
import { authorizeStandReadOwner } from "./read-authority";

import { redactQueryError } from "@/lib/db/pg-error";
import {
  executionCommands,
  standAuthorizationPermits,
  standOperationObservations,
  standOperationReceipts,
  standOperations,
  standResourceClaims,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { markSucceeded } from "@/lib/execution-host/commands";

function conflict(reason: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The target receipt does not match the retained restart",
    { details: { reason } },
  );
}

async function requireCurrentReconciliation(
  tx: Db,
  operation: typeof standOperations.$inferSelect,
  readEpoch: number,
): Promise<void> {
  const [target] = await tx
    .select()
    .from(standTargets)
    .where(eq(standTargets.id, operation.targetId))
    .for("share");

  if (!target?.enabled || target.configRevision !== operation.configRevision)
    throw conflict("target_identity_mismatch");
  await authorizeStandReadOwner(
    tx,
    operation,
    target.companyId,
    "reconcile",
    readEpoch,
  );
}

/** An ambiguous transport outcome cannot release the resource. */
export async function retainStandUnknown(
  db: Db,
  operationId: string,
  owner: Readonly<{ dispatchEpoch: number }> | Readonly<{ readEpoch: number }>,
): Promise<StandOperation> {
  try {
    return await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(standOperations)
        .where(eq(standOperations.id, operationId))
        .for("no key update");
      const [claim] = await tx
        .select()
        .from(standResourceClaims)
        .where(eq(standResourceClaims.operationId, operationId))
        .for("share");

      if (!operation || !claim?.unresolved) throw conflict("assignment_fenced");
      if ("readEpoch" in owner)
        await requireCurrentReconciliation(tx, operation, owner.readEpoch);
      else if (claim.ownerEpoch !== owner.dispatchEpoch)
        throw conflict("assignment_fenced");
      if (operation.effectState === "unknown")
        return operationDto(
          operation,
          null,
          await readStandReceiptIds(tx, operationId),
        );
      if (operation.effectState !== "dispatching")
        throw conflict("stand_effect_changed");

      const [updated] = await tx
        .update(standOperations)
        .set({ effectState: "unknown", revision: operation.revision + 1 })
        .where(eq(standOperations.id, operationId))
        .returning();

      return operationDto(
        updated,
        null,
        await readStandReceiptIds(tx, operationId),
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

async function bindDispatch(
  tx: Db,
  operationId: string,
  claim: typeof standResourceClaims.$inferSelect,
  receipt: StandTargetReceipt,
): Promise<void> {
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.id, claim.ownerId),
        eq(executionCommands.kind, "stand.dispatch"),
      ),
    );
  const beforeId = command?.payload.beforeObservationId;

  if (
    command?.payload.operationId !== operationId ||
    typeof beforeId !== "string"
  )
    throw conflict("stand_dispatch_missing");
  const [before] = await tx
    .select()
    .from(standOperationObservations)
    .where(
      and(
        eq(standOperationObservations.id, beforeId),
        eq(standOperationObservations.operationId, operationId),
      ),
    );

  if (
    !before ||
    before.invocationId !== receipt.beforeInvocation ||
    receipt.sequence <= before.targetSequence
  )
    throw conflict("stand_observation_mismatch");
  if (receipt.permitId) {
    const [permit] = await tx
      .select()
      .from(standAuthorizationPermits)
      .where(
        and(
          eq(standAuthorizationPermits.id, receipt.permitId),
          eq(standAuthorizationPermits.operationId, operationId),
          eq(standAuthorizationPermits.ownerEpoch, claim.ownerEpoch),
          eq(standAuthorizationPermits.purpose, "dispatch"),
        ),
      );

    if (!permit) throw conflict("stand_permit_mismatch");
  }
}

/** Accept a receipt from the authenticated helper transport and settle the exact retained intent. */
export async function adoptStandTargetReceipt(
  db: Db,
  operationId: string,
  raw: unknown,
  readEpoch?: number,
): Promise<StandOperation> {
  const parsed = standTargetReceiptSchema.safeParse(raw);

  if (!parsed.success || parsed.data.operationId !== operationId)
    throw conflict("invalid_target_receipt");
  const receipt = parsed.data;
  const { effectState } = receipt;
  const confirmed =
    effectState === "confirmed_applied" ||
    effectState === "confirmed_not_applied";

  if (
    effectState === "not_dispatched" ||
    effectState === "dispatching" ||
    (effectState === "confirmed_applied" &&
      (!receipt.permitId ||
        receipt.receiptRevision !== 3 ||
        receipt.observedState !== "active" ||
        receipt.afterInvocation === null ||
        receipt.afterInvocation === receipt.beforeInvocation ||
        receipt.reason !== null)) ||
    (effectState === "confirmed_not_applied" &&
      (receipt.receiptRevision !== 2 ||
        receipt.permitId !== null ||
        receipt.afterInvocation !== null ||
        (receipt.reason !== "authority_refused" &&
          receipt.reason !== "before_state_changed"))) ||
    (effectState === "unknown" &&
      (!receipt.permitId ||
        !(
          (receipt.receiptRevision === 2 && receipt.reason === null) ||
          (receipt.receiptRevision === 3 && receipt.reason === "effect_unknown")
        )))
  )
    throw conflict("invalid_target_receipt");
  const receiptDigest = contentDigest(receipt);

  try {
    return await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(standOperations)
        .where(eq(standOperations.id, operationId))
        .for("no key update");

      if (
        !operation ||
        operation.targetIncarnation !== receipt.targetIncarnation ||
        operation.requestDigest !== receipt.requestDigest
      )
        throw conflict("target_identity_mismatch");
      if (readEpoch !== undefined)
        await requireCurrentReconciliation(tx, operation, readEpoch);
      const [previous] = await tx
        .select()
        .from(standOperationReceipts)
        .where(
          and(
            eq(standOperationReceipts.operationId, operationId),
            eq(
              standOperationReceipts.targetReceiptRevision,
              receipt.receiptRevision,
            ),
          ),
        );

      if (previous) {
        if (previous.receiptDigest !== receiptDigest)
          throw conflict("target_receipt_changed");

        return operationDto(
          operation,
          null,
          await readStandReceiptIds(tx, operationId),
          await readStandVerificationIds(tx, operationId),
        );
      }
      if (
        operation.effectState !== "dispatching" &&
        operation.effectState !== "unknown"
      )
        throw conflict("stand_effect_changed");
      const [claim] = await tx
        .select()
        .from(standResourceClaims)
        .where(eq(standResourceClaims.operationId, operationId))
        .for("no key update");

      if (!claim?.unresolved) throw conflict("assignment_fenced");
      await bindDispatch(tx, operationId, claim, receipt);
      await tx.insert(standOperationReceipts).values({
        operationId,
        targetReceiptRevision: receipt.receiptRevision,
        targetSequence: receipt.sequence,
        permitId: receipt.permitId,
        receipt,
        receiptDigest,
        capturedAt: new Date(receipt.capturedAt),
      });
      const receiptIds = await readStandReceiptIds(tx, operationId);

      if (operation.effectState === effectState)
        return operationDto(operation, null, receiptIds);
      const disposition =
        effectState === "confirmed_applied"
          ? "proved_applied"
          : effectState === "confirmed_not_applied"
            ? "proved_not_applied"
            : "pending";
      const [updated] = await tx
        .update(standOperations)
        .set({ effectState, disposition, revision: operation.revision + 1 })
        .where(eq(standOperations.id, operationId))
        .returning();

      if (confirmed)
        await tx
          .update(standResourceClaims)
          .set({ unresolved: false })
          .where(eq(standResourceClaims.operationId, operationId));
      if (confirmed && readEpoch !== undefined)
        await markSucceeded(tx, claim.ownerId, null, {
          operationId,
          effectState,
        });

      return operationDto(updated, null, receiptIds);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
