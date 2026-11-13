import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandAction, StandOperation } from "./operation-types";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { standOperationInputSchema } from "./operation-types";
import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import {
  standComponents,
  standOperations,
  standResourceClaims,
  standTargets,
} from "@/lib/db/schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
  lockSpecialistAssignment,
} from "@/lib/specialist-assignments/store";

const log = pino({
  name: "stand-operation-intake",
  level: process.env.LOG_LEVEL ?? "info",
});
const terminalAssignments = new Set(["completed", "failed", "cancelled"]);

function operationDto(
  operation: typeof standOperations.$inferSelect,
  successorId: string | null = null,
): StandOperation {
  return {
    id: operation.id,
    assignmentId: operation.assignmentId,
    componentId: operation.componentId,
    targetIncarnation: operation.targetIncarnation,
    requestDigest: operation.requestDigest,
    effectState: operation.effectState,
    verificationState: operation.verificationState,
    disposition: operation.disposition,
    receiptIds: [],
    verificationIds: [],
    predecessorId: operation.predecessorId,
    successorId,
    revision: operation.revision,
  };
}

function operationScope(
  action: StandAction,
): "targets:logs" | "targets:restart" | "targets:read" {
  if (action === "logs") return "targets:logs";
  if (action === "restart") return "targets:restart";

  return "targets:read";
}

/** Retain a request before any transport or approval action. No restart is authorized here. */
export async function createStandOperation(
  db: Db,
  userId: string,
  assignmentId: string,
  raw: unknown,
): Promise<{ operation: StandOperation; duplicate: boolean }> {
  const parsed = standOperationInputSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Provide an exact assignment input revision and configured stand action",
    );
  const input = parsed.data;
  const deliveryDigest = contentDigest({ assignmentId, input });

  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);
      const read = await authorizeCompanyUserAction(
        tx,
        userId,
        companyId,
        "targets:read",
      );

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stand-operation:${assignmentId}:${userId}:${input.idempotencyKey}`},0))`,
      );
      const [previous] = await tx
        .select()
        .from(standOperations)
        .where(
          and(
            eq(standOperations.assignmentId, assignmentId),
            eq(standOperations.initiatingUserId, userId),
            eq(standOperations.deliveryKey, input.idempotencyKey),
          ),
        );

      if (previous) {
        await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          assignmentId,
          previous.inputRevision,
        );
        await authorizeCompanyUserAction(
          tx,
          userId,
          companyId,
          operationScope(previous.action),
        );
        if (previous.deliveryDigest !== deliveryDigest)
          throw new MaisterError(
            "CONFLICT",
            "The stand operation delivery key already names different input",
          );

        return { operation: operationDto(previous), duplicate: true };
      }
      await lockSpecialistAssignment(tx, assignmentId, input.expectedRevision);
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const action = await authorizeCompanyUserAction(
        tx,
        userId,
        companyId,
        operationScope(input.action),
      );

      if (
        assignment.inputRevision !== input.inputRevision ||
        terminalAssignments.has(assignment.status)
      )
        throw new MaisterError(
          "CONFLICT",
          "The stand operation requires the current open assignment input",
        );
      if (assignment.targetIds.length === 0)
        throw new MaisterError(
          "PRECONDITION",
          "Appoint the configured stand to the assignment first",
          { details: { reason: "stand_target_unavailable" } },
        );
      const capturedInput = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        input.inputRevision,
      );
      const matches = await tx
        .select({ target: standTargets, component: standComponents })
        .from(standTargets)
        .innerJoin(
          standComponents,
          and(
            eq(standComponents.targetId, standTargets.id),
            eq(standComponents.configRevision, standTargets.configRevision),
          ),
        )
        .where(
          and(
            eq(standTargets.companyId, companyId),
            eq(standTargets.enabled, true),
            inArray(standTargets.id, assignment.targetIds),
            eq(standComponents.componentId, input.componentId),
          ),
        )
        .limit(2)
        .for("share", { of: standTargets });

      if (matches.length !== 1)
        throw new MaisterError(
          "PRECONDITION",
          "Select one exact enabled component from the appointed stands",
          { details: { reason: "stand_target_unavailable" } },
        );
      const { target, component } = matches[0]!;

      if (!component.config.actions.includes(input.action))
        throw new MaisterError(
          "UNAUTHORIZED",
          "The configured component does not allow this stand action",
        );
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
      const requestDigest = contentDigest({
        owner: assignment.owner,
        assignmentId,
        inputRevision: input.inputRevision,
        inputSha256: capturedInput.digest,
        targetId: target.id,
        incarnationId: target.incarnationId,
        configRevision: target.configRevision,
        resourceKey: component.canonicalResourceKey,
        componentId: input.componentId,
        action: input.action,
        runbookSha256: component.runbookSha256,
        verification: capturedInput.snapshot.objectiveInput.verification,
      });
      const [operation] = await tx
        .insert(standOperations)
        .values({
          assignmentId,
          assignmentRevision: input.expectedRevision,
          inputRevision: input.inputRevision,
          inputSha256: capturedInput.digest,
          targetId: target.id,
          configRevision: target.configRevision,
          componentId: input.componentId,
          resourceKey: component.canonicalResourceKey,
          targetIncarnation: target.incarnationId,
          action: input.action,
          initiatingUserId: userId,
          deliveryKey: input.idempotencyKey,
          deliveryDigest,
          requestDigest,
          authority:
            action.witness.action === read.witness.action
              ? [read.witness]
              : [read.witness, action.witness],
        })
        .returning();

      if (!operation)
        throw new MaisterError(
          "CRASH",
          "Stand operation intent was not retained",
        );
      if (input.action === "restart") {
        const expiresAt = sql`clock_timestamp()+interval '120 seconds'`;
        const [claim] = await tx
          .insert(standResourceClaims)
          .values({
            resourceKey: operation.resourceKey,
            operationId: operation.id,
            ownerId: operation.id,
            expiresAt,
          })
          .onConflictDoUpdate({
            target: standResourceClaims.resourceKey,
            set: {
              operationId: operation.id,
              ownerId: operation.id,
              ownerEpoch: sql`${standResourceClaims.ownerEpoch}+1`,
              expiresAt,
              unresolved: true,
            },
            setWhere: eq(standResourceClaims.unresolved, false),
          })
          .returning({ operationId: standResourceClaims.operationId });

        if (!claim)
          throw new MaisterError(
            "CONFLICT",
            "Reconcile the retained operation before requesting another restart of this resource",
            { details: { reason: "resource_conflict" } },
          );
      }
      log.info(
        {
          operationId: operation.id,
          assignmentId,
          targetIncarnation: operation.targetIncarnation,
          resourceKey: operation.resourceKey,
          requestDigest,
          effectState: operation.effectState,
        },
        "stand operation intent retained",
      );

      return { operation: operationDto(operation), duplicate: false };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export async function getStandOperation(
  db: Db,
  userId: string,
  operationId: string,
): Promise<StandOperation> {
  return db.transaction(async (tx) => {
    const companyId = await installationCompany(tx);

    await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
    const [operation] = await tx
      .select()
      .from(standOperations)
      .innerJoin(standTargets, eq(standTargets.id, standOperations.targetId))
      .where(
        and(
          eq(standOperations.id, operationId),
          eq(standTargets.companyId, companyId),
        ),
      );

    if (!operation)
      throw new MaisterError(
        "PRECONDITION",
        "The retained stand operation is unavailable",
        { details: { reason: "stand_operation_unavailable" } },
      );
    await getSpecialistAssignmentInputInTransaction(
      tx,
      userId,
      operation.stand_operations.assignmentId,
      operation.stand_operations.inputRevision,
    );
    const [successor] = await tx
      .select({ id: standOperations.id })
      .from(standOperations)
      .where(eq(standOperations.predecessorId, operationId));

    return operationDto(operation.stand_operations, successor?.id ?? null);
  });
}
