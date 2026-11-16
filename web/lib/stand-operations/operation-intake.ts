import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { StandAction, StandOperation } from "./operation-types";

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  resolveStandCredential,
  resolveStandExecutionActor,
} from "./execution-actor";
import { standInspectionAppointmentSchema } from "./scheduled-inspection-types";
import { standOperationInputSchema } from "./operation-types";
import {
  readStandReceiptIds,
  readStandVerificationIds,
} from "./receipt-queries";
import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import {
  standComponents,
  standOperationReceipts,
  standOperations,
  standResourceClaims,
  standRestartApprovals,
  standTargets,
  standVerifications,
} from "@/lib/db/schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
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

export function operationDto(
  operation: typeof standOperations.$inferSelect,
  successorId: string | null = null,
  receiptIds: readonly string[] = [],
  verificationIds: readonly string[] = [],
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
    receiptIds,
    verificationIds,
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

async function readAssignmentStandAppointment(
  tx: SqlTransaction,
  origin: { triggerAttemptId: string; scheduleId: string },
) {
  const [source] = (
    await tx.execute(sql`
    SELECT stand_inspection FROM agent_trigger_attempts
    WHERE id=${origin.triggerAttemptId} AND schedule_id=${origin.scheduleId}
  `)
  ).rows;

  return source?.stand_inspection == null
    ? null
    : standInspectionAppointmentSchema.parse(source.stand_inspection);
}

function unavailableInspectionAppointment(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "This scheduled assignment can only inspect its exact appointed component revision",
    {
      details: { reason: "stand_target_unavailable" },
    },
  );
}

/** A retained human decision can appoint a restart before the specialist asks for it. */
async function readAppointedStandSuccessor(
  tx: Db,
  selection: Pick<
    typeof standOperations.$inferSelect,
    | "assignmentId"
    | "inputRevision"
    | "inputSha256"
    | "targetId"
    | "configRevision"
    | "targetIncarnation"
    | "componentId"
    | "initiatingUserId"
    | "resourceKey"
  >,
): Promise<StandOperation | null> {
  const appointments = await tx
    .select()
    .from(standOperations)
    .where(
      and(
        eq(standOperations.resourceKey, selection.resourceKey),
        isNotNull(standOperations.predecessorId),
        eq(standOperations.assignmentId, selection.assignmentId),
        eq(standOperations.inputRevision, selection.inputRevision),
        eq(standOperations.inputSha256, selection.inputSha256),
        eq(standOperations.targetId, selection.targetId),
        eq(standOperations.configRevision, selection.configRevision),
        eq(standOperations.targetIncarnation, selection.targetIncarnation),
        eq(standOperations.componentId, selection.componentId),
        eq(standOperations.initiatingUserId, selection.initiatingUserId),
        sql`NOT EXISTS (SELECT 1 FROM stand_operations next_operation WHERE next_operation.predecessor_id=${standOperations.id})`,
      ),
    )
    .limit(2);

  if (appointments.length > 1)
    throw new MaisterError(
      "CONFLICT",
      "Multiple retained recovery operations match this assignment input",
    );
  const [operation] = appointments;

  if (!operation) return null;

  return operationDto(
    operation,
    null,
    await readStandReceiptIds(tx, operation.id),
    await readStandVerificationIds(tx, operation.id),
  );
}

/** Retain a request before any transport or approval action. No restart is authorized here. */
export async function createStandOperation(
  db: Db,
  principal: string | Readonly<{ tokenId: string }>,
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

  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);
      const actor =
        typeof principal === "string"
          ? null
          : await resolveStandExecutionActor(
              tx,
              await resolveStandCredential(tx, principal.tokenId),
              assignmentId,
              input.inputRevision,
              operationScope(input.action),
            );
      const userId = typeof principal === "string" ? principal : actor?.userId;

      if (!userId || (actor && actor.companyId !== companyId))
        throw new MaisterError(
          "UNAUTHORIZED",
          "The stand assignment execution is unavailable",
        );
      const execution = actor
        ? {
            agentId: actor.agentId,
            runId: actor.runId,
            nodeAttemptId: actor.nodeAttemptId,
          }
        : null;
      const deliveryDigest = contentDigest({
        assignmentId,
        input,
        ...(actor ? { professional: actor.agentId } : {}),
      });
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

        return {
          operation: operationDto(
            previous,
            null,
            await readStandReceiptIds(tx, previous.id),
            await readStandVerificationIds(tx, previous.id),
          ),
          duplicate: true,
        };
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
      const appointment =
        assignment.origin.kind === "schedule"
          ? await readAssignmentStandAppointment(tx, assignment.origin)
          : null;

      if (
        appointment &&
        (input.action !== "inspect" ||
          input.componentId !== appointment.componentId)
      )
        throw unavailableInspectionAppointment();
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
      if (
        appointment &&
        (appointment.targetId !== target.id ||
          appointment.configRevision !== target.configRevision ||
          appointment.incarnationId !== target.incarnationId)
      )
        throw unavailableInspectionAppointment();

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

      const appointmentWitness = {
        assignmentId,
        inputRevision: input.inputRevision,
        inputSha256: capturedInput.digest,
        targetId: target.id,
        configRevision: target.configRevision,
        targetIncarnation: target.incarnationId,
        componentId: input.componentId,
        initiatingUserId: userId,
        resourceKey: component.canonicalResourceKey,
      };

      if (input.action === "restart") {
        const appointed = await readAppointedStandSuccessor(
          tx,
          appointmentWitness,
        );

        if (appointed) {
          log.info(
            {
              operationId: appointed.id,
              assignmentId,
              predecessorId: appointed.predecessorId,
            },
            "stand restart uses the authorized successor",
          );

          return { operation: appointed, duplicate: true };
        }
      }
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
        ...(actor ? { professional: actor.agentId } : {}),
      });
      const [operation] = await tx
        .insert(standOperations)
        .values({
          ...appointmentWitness,
          assignmentRevision: input.expectedRevision,
          action: input.action,
          initiatingExecution: execution,
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
  return (await readStandOperation(db, userId, operationId)).operation;
}

/** An operator sees the exact evidence only after the same current target and source checks as the operation. */
export async function readStandOperationEvidence(
  db: Db,
  userId: string,
  operationId: string,
): Promise<{
  operation: StandOperation;
  action: StandAction;
  approvedAt: Date | null;
  effect: {
    id: string;
    capturedAt: Date;
    receipt: typeof standOperationReceipts.$inferSelect.receipt;
  }[];
  verification: {
    id: string;
    observedAt: Date;
    state: typeof standVerifications.$inferSelect.state;
    effectReceiptId: string | null;
  }[];
}> {
  return readStandOperation(db, userId, operationId);
}

async function readStandOperation(db: Db, userId: string, operationId: string) {
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
    const current = operation.stand_operations;
    const linked = await tx
      .select({
        id: standOperations.id,
        assignmentId: standOperations.assignmentId,
        inputRevision: standOperations.inputRevision,
      })
      .from(standOperations)
      .where(
        current.predecessorId
          ? sql`${standOperations.id}=${current.predecessorId} OR ${standOperations.predecessorId}=${operationId}`
          : eq(standOperations.predecessorId, operationId),
      );
    const visible = new Set<string>();

    for (const entry of linked) {
      try {
        await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          entry.assignmentId,
          entry.inputRevision,
        );
        visible.add(entry.id);
      } catch (error) {
        if (
          !isMaisterError(error) ||
          !["UNAUTHORIZED", "PRECONDITION"].includes(error.code)
        )
          throw error;
      }
    }
    const successor = linked.find(
      (entry) => entry.id !== current.predecessorId,
    );

    const [approval] = await tx
      .select({ approvedAt: standRestartApprovals.approvedAt })
      .from(standRestartApprovals)
      .where(eq(standRestartApprovals.operationId, operationId));
    const effect = await tx
      .select({
        id: standOperationReceipts.id,
        capturedAt: standOperationReceipts.capturedAt,
        receipt: standOperationReceipts.receipt,
      })
      .from(standOperationReceipts)
      .where(eq(standOperationReceipts.operationId, operationId))
      .orderBy(asc(standOperationReceipts.targetReceiptRevision));
    const verification = await tx
      .select({
        id: standVerifications.id,
        observedAt: standVerifications.observedAt,
        state: standVerifications.state,
        effectReceiptId: standVerifications.effectReceiptId,
      })
      .from(standVerifications)
      .where(eq(standVerifications.operationId, operationId))
      .orderBy(asc(standVerifications.targetSequence));

    const view = operationDto(
      {
        ...current,
        predecessorId:
          current.predecessorId && visible.has(current.predecessorId)
            ? current.predecessorId
            : null,
      },
      successor && visible.has(successor.id) ? successor.id : null,
      effect.map(({ id }) => id),
      verification.map(({ id }) => id),
    );

    return {
      operation: view,
      action: current.action,
      approvedAt: approval?.approvedAt ?? null,
      effect,
      verification,
    };
  });
}
