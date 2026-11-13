import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandSuccessorDecision } from "./operation-types";

import { and, desc, eq, sql } from "drizzle-orm";

import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  standComponents,
  standOperationObservations,
  standOperations,
  standResourceClaims,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";

type Operation = typeof standOperations.$inferSelect;

/** Retain an independently approved intent for the same resource and a current work appointment. */
export async function retainStandSuccessor(
  tx: Db,
  predecessor: Operation,
  companyId: string,
  userId: string,
  decision: StandSuccessorDecision,
): Promise<Operation> {
  const { assignmentId, expectedRevision, inputRevision } = decision.successor;
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    userId,
    assignmentId,
  );

  const captured = await getSpecialistAssignmentInputInTransaction(
    tx,
    userId,
    assignmentId,
    inputRevision,
  );
  const read = await authorizeCompanyUserAction(
    tx,
    userId,
    companyId,
    "targets:read",
  );
  const restart = await authorizeCompanyUserAction(
    tx,
    userId,
    companyId,
    "targets:restart",
  );
  const [configured] = await tx
    .select({ component: standComponents })
    .from(standTargets)
    .innerJoin(
      standComponents,
      and(
        eq(standComponents.targetId, standTargets.id),
        eq(standComponents.configRevision, standTargets.configRevision),
        eq(standComponents.componentId, predecessor.componentId),
      ),
    )
    .where(
      and(
        eq(standTargets.id, predecessor.targetId),
        eq(standTargets.companyId, companyId),
        eq(standTargets.enabled, true),
        eq(standTargets.configRevision, predecessor.configRevision),
      ),
    )
    .for("share", { of: standTargets });

  if (
    assignment.revision !== expectedRevision ||
    assignment.inputRevision !== inputRevision ||
    ["completed", "failed", "cancelled"].includes(assignment.status) ||
    !assignment.targetIds.includes(predecessor.targetId) ||
    !configured?.component.config.actions.includes("restart")
  )
    throw new MaisterError(
      "CONFLICT",
      "A successor requires a current open assignment and the same configured restart",
    );
  const component = configured.component;

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
  const [inspection] = await tx
    .select()
    .from(standOperationObservations)
    .where(
      and(
        eq(standOperationObservations.operationId, predecessor.id),
        eq(standOperationObservations.recoveryRevision, predecessor.revision),
        sql`${standOperationObservations.receivedAt}>=clock_timestamp()-interval '5 minutes'`,
      ),
    )
    .orderBy(desc(standOperationObservations.targetSequence))
    .limit(1);

  if (
    !inspection ||
    inspection.id !== decision.inspectionIds[0] ||
    inspection.observedState !== "active" ||
    !inspection.invocationId
  )
    throw new MaisterError(
      "CONFLICT",
      "A fresh, known active inspection of the original operation is required",
    );
  const requestDigest = contentDigest({
    predecessorId: predecessor.id,
    predecessorRevision: predecessor.revision,
    inspectionId: inspection.id,
    targetSequence: inspection.targetSequence,
    owner: assignment.owner,
    assignmentId,
    inputRevision,
    inputSha256: captured.digest,
    targetId: predecessor.targetId,
    configRevision: predecessor.configRevision,
    targetIncarnation: predecessor.targetIncarnation,
    componentId: predecessor.componentId,
    resourceKey: predecessor.resourceKey,
    action: "restart",
    runbookSha256: component.runbookSha256,
    verification: captured.snapshot.objectiveInput.verification,
  });
  const [successor] = await tx
    .insert(standOperations)
    .values({
      predecessorId: predecessor.id,
      assignmentId,
      assignmentRevision: expectedRevision,
      inputRevision,
      inputSha256: captured.digest,
      targetId: predecessor.targetId,
      configRevision: predecessor.configRevision,
      componentId: predecessor.componentId,
      resourceKey: predecessor.resourceKey,
      targetIncarnation: predecessor.targetIncarnation,
      action: "restart",
      initiatingUserId: userId,
      deliveryKey: decision.idempotencyKey,
      deliveryDigest: contentDigest({
        predecessorId: predecessor.id,
        decision,
      }),
      requestDigest,
      authority: [read.witness, restart.witness],
    })
    .returning();

  if (!successor)
    throw new MaisterError("CRASH", "The successor restart was not retained");

  return successor;
}

/** Carry forward the unresolved exclusion and advance the resource fence. */
export async function transferStandResource(
  tx: Db,
  predecessor: Operation,
  successor: Operation,
): Promise<void> {
  const [transferred] = await tx
    .update(standResourceClaims)
    .set({
      operationId: successor.id,
      ownerId: successor.id,
      ownerEpoch: sql`${standResourceClaims.ownerEpoch}+1`,
      expiresAt: sql`clock_timestamp()+interval '120 seconds'`,
    })
    .where(
      and(
        eq(standResourceClaims.operationId, predecessor.id),
        eq(standResourceClaims.resourceKey, predecessor.resourceKey),
        eq(standResourceClaims.unresolved, true),
        sql`${standResourceClaims.expiresAt}<=clock_timestamp()-interval '5 seconds'`,
      ),
    )
    .returning({ operationId: standResourceClaims.operationId });

  if (!transferred)
    throw new MaisterError(
      "CONFLICT",
      "Wait for the original dispatch and permit to expire before authorizing a successor",
    );
}
