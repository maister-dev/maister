import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { AssignmentOrigin } from "./types";
import type { CompanyAssignmentRequest } from "./company-intake";

import pino from "pino";

import {
  intakeSpecialistAssignmentInTransaction,
  inspectSpecialistIntakeReplayInTransaction,
} from "./intake";
import { getSpecialistAssignmentInTransaction } from "./store";
import { prepareCompanySpecialistAssignment } from "./company-intake";
import { reserveCompanyAssignmentRunInTransaction } from "./company-reservation";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, localHost } from "@/lib/execution-host";

const log = pino({
  name: "company-request-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reserve authenticated user work atomically; immutable source identity and literal input stay separate from native trigger policy. */
export async function reserveCompanyUserRequest(
  db: Db,
  userId: string,
  originalRequest: CompanyAssignmentRequest,
  origin: AssignmentOrigin,
  triggerSource: "manual" | "webhook",
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<SpecialistIntakeReceipt> {
  if (origin.kind !== triggerSource)
    throw new MaisterError(
      "CONFIG",
      "Company user request origin must match its actual invocation trigger",
    );
  try {
    const replay = await db.transaction(async (tx) => {
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeCompanyUserAction(
          tx,
          userId,
          originalRequest.owner.companyId,
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
        triggerSource,
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
          companyId: originalRequest.owner.companyId,
        },
        "company user request and existing Run reserved atomically",
      );

      return { ...receipt, assignment };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
