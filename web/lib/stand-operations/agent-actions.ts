import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { eq } from "drizzle-orm";

import {
  resolveStandCredential,
  resolveStandExecutionActor,
} from "./execution-actor";
import { getStandOperation } from "./operation-intake";
import { observeBeforeStandRestart } from "./observe";
import {
  deliverStandRestartCommand,
  prepareStandRestartDispatch,
} from "./restart-dispatch";
import { verifyStandRestart } from "./verify";

import { standOperations } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export async function observeSpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandOperation> {
  const { operation, userId } = await authorizeSpecialistOperation(
    db,
    tokenId,
    operationId,
    "targets:read",
  );

  await observeBeforeStandRestart(
    db,
    { tokenId },
    operationId,
    operation.revision,
  );

  return getStandOperation(db, userId, operationId);
}

export async function getSpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandOperation> {
  const { userId } = await authorizeSpecialistOperation(
    db,
    tokenId,
    operationId,
    "targets:read",
  );

  return getStandOperation(db, userId, operationId);
}

export async function verifySpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandOperation> {
  const { operation } = await authorizeSpecialistOperation(
    db,
    tokenId,
    operationId,
    "targets:read",
  );

  return verifyStandRestart(db, { tokenId }, operationId, operation.revision);
}

export async function dispatchSpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandOperation> {
  const { operation, userId } = await authorizeSpecialistOperation(
    db,
    tokenId,
    operationId,
    "targets:restart",
  );

  if (operation.effectState !== "not_dispatched")
    return getStandOperation(db, userId, operationId);

  const command = await prepareStandRestartDispatch(db, {
    operationId,
    tokenId,
  });

  return deliverStandRestartCommand(db, command);
}

async function authorizeSpecialistOperation(
  db: Db,
  tokenId: string,
  operationId: string,
  action: "targets:read" | "targets:restart",
): Promise<{ operation: typeof standOperations.$inferSelect; userId: string }> {
  return db.transaction(async (tx) => {
    const identity = await resolveStandCredential(tx, tokenId);
    const [operation] = await tx
      .select()
      .from(standOperations)
      .where(eq(standOperations.id, operationId));

    if (!operation)
      throw new MaisterError(
        "PRECONDITION",
        "The retained stand operation is unavailable",
        {
          details: { reason: "stand_operation_unavailable" },
        },
      );
    const { userId } = await resolveStandExecutionActor(
      tx,
      identity,
      operation.assignmentId,
      operation.inputRevision,
      action,
    );

    if (userId !== operation.initiatingUserId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The execution cannot access this stand operation",
      );

    return { operation, userId };
  });
}
