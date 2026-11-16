import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyTriggerReservation } from "@/lib/agents/company-trigger-reservation";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";
import type { CompanyAssignmentRequest } from "./company-intake";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { AssignmentOrigin } from "./types";

import pino from "pino";

import { prepareCompanySpecialistAssignment } from "./company-intake";
import { reserveCompanyAssignmentRunInTransaction } from "./company-reservation";
import {
  inspectSpecialistIntakeReplayInTransaction,
  intakeSpecialistAssignmentInTransaction,
} from "./intake";
import { getSpecialistAssignmentInTransaction } from "./store";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { localHost } from "@/lib/execution-host";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

export type CompanyTriggerInvocation = Readonly<{
  userId: string;
  companyId: string;
  outcome: string | null;
  request: CompanyAssignmentRequest;
  origin: AssignmentOrigin;
  scheduledRequest: ScheduledAgentRequestSnapshot | null;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
  triggerSource: "cron" | "domain_event";
}>;
type LoadCompanyTriggerInvocation = (
  tx: SqlTransaction,
  reservation: CompanyTriggerReservation,
) => Promise<CompanyTriggerInvocation>;
const log = pino({
  name: "company-trigger-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Source adapters validate identity and disclosure; one shared transaction owns canonical intake and native Run reservation. */
export async function reserveCompanyTriggerAssignment(
  db: Db,
  invocation: CompanyTriggerReservation,
  loadInvocation: LoadCompanyTriggerInvocation,
  hosts: ExecutionHosts,
): Promise<SpecialistIntakeReceipt> {
  try {
    const retained = await db.transaction(async (tx) => {
      const source = await loadInvocation(tx, invocation);

      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeCompanyUserAction(
          tx,
          source.userId,
          source.companyId,
          action,
        );
      const replay = await inspectSpecialistIntakeReplayInTransaction(
        tx,
        source.userId,
        source.origin,
        source.request,
      );

      return { source, replay };
    });

    if (retained.replay) return retained.replay;
    if (retained.source.outcome !== null)
      throw new MaisterError(
        "CONFLICT",
        "A settled company invocation cannot be dispatched again",
        {
          details: { reason: "company_trigger_already_settled" },
        },
      );
    const host = await localHost({ db, transport: hosts.transport });

    return await db.transaction(async (tx) => {
      const source = await loadInvocation(tx, invocation);
      const receipt = await intakeSpecialistAssignmentInTransaction(
        tx,
        source.userId,
        source.origin,
        source.request,
        async (sourceTx) => {
          const prepared = await prepareCompanySpecialistAssignment(
            sourceTx,
            source.userId,
            source.request,
            {
              origin: source.origin,
              scheduledRequest: source.scheduledRequest,
              destination: { kind: "inbox", userId: source.userId },
            },
          );

          return { ...prepared, sourceRestrictions: source.sourceRestrictions };
        },
      );

      if (receipt.duplicate) return receipt;
      await reserveCompanyAssignmentRunInTransaction(
        tx,
        source.userId,
        receipt,
        source.triggerSource,
        hosts,
        host,
        invocation,
      );

      return {
        ...receipt,
        assignment: await getSpecialistAssignmentInTransaction(
          tx,
          source.userId,
          receipt.assignment.id,
        ),
      };
    });
  } catch (error) {
    log.warn(
      {
        attemptId: invocation.attemptId,
        runId: invocation.runId,
        code: error instanceof MaisterError ? error.code : null,
        ...queryErrorDiagnostics(error),
      },
      "company source reservation refused",
    );
    throw redactQueryError(error);
  }
}
