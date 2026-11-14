import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { and, eq } from "drizzle-orm";

import {
  resolveStandCredential,
  resolveStandExecutionActor,
} from "./execution-actor";
import { getStandOperation } from "./operation-intake";
import { observeBeforeStandRestart } from "./observe";
import { readStandRunbookDigest } from "./target-registry";
import {
  deliverStandRestartCommand,
  prepareStandRestartDispatch,
} from "./restart-dispatch";
import { verifyStandHealth } from "./verify";

import {
  standComponents,
  standOperations,
  standRestartApprovals,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type StandSpecialistView = StandOperation &
  Readonly<{
    approvalState: "not_required" | "required" | "recorded";
    runbook: Readonly<{
      recordId: string;
      revision: number;
      witnessId: string;
    }>;
  }>;

export async function observeSpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<
  StandSpecialistView &
    Readonly<{
      observation: Readonly<{
        id: string;
        invocationId: string | null;
        state: "active" | "inactive" | "failed" | "unknown";
        capturedAt: string;
      }>;
    }>
> {
  const { operation } = await authorizeSpecialistOperation(
    db,
    tokenId,
    operationId,
    "targets:read",
  );

  const observation = await observeBeforeStandRestart(
    db,
    { tokenId },
    operationId,
    operation.revision,
  );

  return {
    ...(await getSpecialistStand(db, tokenId, operationId)),
    observation: {
      id: observation.id,
      invocationId: observation.invocationId,
      state: observation.observedState,
      capturedAt: observation.capturedAt.toISOString(),
    },
  };
}

export async function getSpecialistStand(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandSpecialistView> {
  return db.transaction(async (tx) => {
    const { operation, userId } = await authorizeSpecialistOperation(
      tx,
      tokenId,
      operationId,
      "targets:read",
    );
    const [component] = await tx
      .select({
        config: standComponents.config,
        runbookSha256: standComponents.runbookSha256,
      })
      .from(standComponents)
      .where(
        and(
          eq(standComponents.targetId, operation.targetId),
          eq(standComponents.configRevision, operation.configRevision),
          eq(standComponents.componentId, operation.componentId),
        ),
      );
    const [approval] = await tx
      .select({ operationId: standRestartApprovals.operationId })
      .from(standRestartApprovals)
      .where(eq(standRestartApprovals.operationId, operationId));

    if (!component)
      throw new MaisterError(
        "PRECONDITION",
        "The operation runbook pin is unavailable",
      );
    if (
      (await readStandRunbookDigest(
        tx,
        userId,
        operation.companyId,
        component.config.runbook,
      )) !== component.runbookSha256
    )
      throw new MaisterError(
        "PRECONDITION",
        "The configured runbook witness changed",
      );

    return {
      ...(await getStandOperation(tx, userId, operationId)),
      approvalState:
        operation.action !== "restart"
          ? "not_required"
          : approval
            ? "recorded"
            : "required",
      runbook: component.config.runbook,
    };
  });
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

  return verifyStandHealth(db, { tokenId }, operationId, operation.revision);
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
): Promise<{
  operation: typeof standOperations.$inferSelect &
    Readonly<{ companyId: string }>;
  userId: string;
}> {
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
    const { companyId, userId } = await resolveStandExecutionActor(
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

    return {
      operation: { ...operation, companyId },
      userId,
    };
  });
}
