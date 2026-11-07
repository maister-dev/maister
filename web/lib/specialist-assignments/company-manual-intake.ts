import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { AssignmentOrigin } from "./types";

import pino from "pino";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import {
  intakeSpecialistAssignmentInTransaction,
  inspectSpecialistIntakeReplayInTransaction,
} from "./intake";
import { getSpecialistAssignmentInTransaction } from "./store";
import { prepareCompanySpecialistAssignment } from "./company-intake";
import { reserveCompanyAssignmentRunInTransaction } from "./company-reservation";
import { wakePendingSpecialistAssignment } from "./admission-wake";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { ownerSchema } from "@/lib/company/types";
import { redactQueryError } from "@/lib/db/pg-error";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, localHost } from "@/lib/execution-host";

export const companyManualAssignmentRequestSchema =
  manualSpecialistAssignmentRequestSchema
    .extend({ owner: ownerSchema.options[0] })
    .strict();
const log = pino({
  name: "company-manual-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reserve company manual work through canonical intake and the existing native launchers. */
export async function reserveCompanyManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<SpecialistIntakeReceipt> {
  const parsed = companyManualAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Manual company work requires a bounded original request and idempotency key",
    );
  const request = parsed.data;
  const origin: AssignmentOrigin = {
    kind: "manual",
    interactionId: contentDigest({
      schemaVersion: 1,
      kind: "company_manual_assignment",
      userId,
      idempotencyKey: request.idempotencyKey,
    }),
  };
  const { idempotencyKey: _key, ...originalRequest } = request;

  try {
    const replay = await db.transaction(async (tx) => {
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeCompanyUserAction(
          tx,
          userId,
          request.owner.companyId,
          action,
        );

      return inspectSpecialistIntakeReplayInTransaction(
        tx,
        userId,
        origin,
        originalRequest,
      );
    });

    if (replay) return replay;
    const host = await localHost({ db, transport: hosts.transport });

    return await db.transaction(async (tx) => {
      const receipt = await intakeSpecialistAssignmentInTransaction(
        tx,
        userId,
        origin,
        originalRequest,
        (sourceTx) =>
          prepareCompanySpecialistAssignment(
            sourceTx,
            userId,
            originalRequest,
            {
              origin,
              destination: { kind: "inbox", userId },
              scheduledRequest: null,
            },
          ),
      );

      if (receipt.duplicate) return receipt;
      const reservation = await reserveCompanyAssignmentRunInTransaction(
        tx,
        userId,
        receipt,
        "manual",
        hosts,
        host,
      );
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        receipt.assignment.id,
      );

      log.info(
        {
          receiptId: receipt.receiptId,
          assignmentId: assignment.id,
          runId: reservation.runId,
          companyId: request.owner.companyId,
        },
        "company manual work and existing Run reserved atomically",
      );

      return { ...receipt, assignment };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Wake the existing scheduler after durable intake, including a replay of interrupted admission. */
export async function submitCompanyManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const receipt = await reserveCompanyManualAssignment(db, userId, value);

  await wakePendingSpecialistAssignment(db, receipt);

  return receipt;
}
