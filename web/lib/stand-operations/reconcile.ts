import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { z } from "zod";

import { claimStandReadAuthority } from "./read-authority";
import {
  adoptStandTargetReceipt,
  retainStandUnknown,
} from "./receipt-adoption";
import { getStandOperation } from "./operation-intake";
import { standTargetReceiptSchema } from "./operation-types";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { defaultTransport } from "@/lib/execution-host/default-transport";

const reconciliationRequest = z
  .object({ expectedRevision: knowledgeRevisionSchema })
  .strict();

/** Reconcile the original identity with a purpose-bound read after any dispatch ambiguity. */
export async function reconcileStandRestart(
  db: Db,
  userId: string,
  operationId: string,
  raw: unknown,
  context?: Readonly<{ kind: "scheduler" }>,
): Promise<StandOperation> {
  const parsed = reconciliationRequest.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Select an exact operation revision for reconciliation",
    );
  const { operation, ownerEpoch } = await claimStandReadAuthority(
    db,
    userId,
    operationId,
    "reconcile",
    parsed.data.expectedRevision,
    context,
  );

  if (
    operation.effectState === "not_dispatched" ||
    operation.action !== "restart"
  )
    throw new MaisterError(
      "CONFLICT",
      "This operation has no restart dispatch to reconcile",
    );
  if (
    operation.effectState === "confirmed_applied" ||
    operation.effectState === "confirmed_not_applied" ||
    operation.disposition === "authorized_successor"
  )
    return getStandOperation(db, userId, operationId);
  let rawReceipt: unknown;

  try {
    rawReceipt = await defaultTransport().readStandReceipt({
      operationId,
      targetIncarnation: operation.targetIncarnation,
      requestDigest: operation.requestDigest,
      ownerEpoch,
    });
  } catch (error) {
    if (isMaisterError(error) && error.code === "EXECUTOR_UNAVAILABLE")
      await retainStandUnknown(db, operationId, { readEpoch: ownerEpoch });
    throw error;
  }

  if (rawReceipt !== null) {
    const receipt = standTargetReceiptSchema.safeParse(rawReceipt);

    if (
      !receipt.success ||
      receipt.data.operationId !== operationId ||
      receipt.data.targetIncarnation !== operation.targetIncarnation ||
      receipt.data.requestDigest !== operation.requestDigest
    ) {
      await retainStandUnknown(db, operationId, { readEpoch: ownerEpoch });
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The original target receipt could not be validated",
      );
    }
    if (
      receipt.data.effectState !== "not_dispatched" &&
      receipt.data.effectState !== "dispatching"
    )
      return adoptStandTargetReceipt(db, operationId, receipt.data, ownerEpoch);
  }

  return retainStandUnknown(db, operationId, { readEpoch: ownerEpoch });
}
