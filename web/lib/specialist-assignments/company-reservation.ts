import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyAgentContextInput } from "@/lib/agents/company-agent-context";
import type { CompanyRunReservation } from "@/lib/agents/company-execution-types";
import type { CompanyTriggerReservation } from "@/lib/agents/company-trigger-reservation";
import type { SpecialistIntakePrincipal } from "@/lib/agents/installation-appointment";
import type { SpecialistIntakeReceipt } from "./intake-types";

import {
  loadCompanyAssignmentSpecialist,
  loadCompanyAssignmentCoordinator,
} from "./company-intake";

import { reserveCompanyAgentRunInTransaction } from "@/lib/agents/company-agent-launch";
import { reserveCompanyFlowRunInTransaction } from "@/lib/agents/company-flow-launch";
import { MaisterError } from "@/lib/errors";

/** Reuse the native standalone/graph constructor on the intake transaction after pooled host activation. */
export async function reserveCompanyAssignmentRunInTransaction(
  tx: Db,
  principal: SpecialistIntakePrincipal,
  receipt: SpecialistIntakeReceipt,
  triggerSource: CompanyAgentContextInput["triggerSource"],
  hosts: ExecutionHosts,
  host: ExecutionHost,
  invocation?: CompanyTriggerReservation,
): Promise<CompanyRunReservation> {
  const owner = receipt.assignment.owner;

  if (owner.kind !== "company")
    throw new MaisterError(
      "CONFIG",
      "Company reservation requires an explicit company assignment",
    );
  const specialist = await loadCompanyAssignmentSpecialist(tx, {
    owner,
    specialistBindingId: receipt.assignment.specialistBindingId,
  });
  const common = {
    companyId: owner.companyId,
    assignmentId: receipt.assignment.id,
    assignmentRevision: receipt.assignment.revision,
    inputRevision: receipt.inputRevision,
    bindingId: specialist.head.id,
    bindingRevision: specialist.head.revision,
    triggerSource,
  };
  let reservation: Awaited<
    ReturnType<typeof reserveCompanyAgentRunInTransaction>
  >;

  if (specialist.revision.snapshot.definition.flow) {
    if (typeof principal !== "string")
      throw new MaisterError(
        "PRECONDITION",
        "Installation source appointments require a standalone specialist",
      );
    const coordinator = await loadCompanyAssignmentCoordinator(
      tx,
      owner.companyId,
      specialist,
    );

    reservation = await reserveCompanyFlowRunInTransaction(
      tx,
      principal,
      {
        ...common,
        coordinatorBindingId: coordinator.head.id,
        coordinatorBindingRevision: coordinator.head.revision,
      },
      hosts,
      host,
      invocation,
    );
  } else
    reservation = await reserveCompanyAgentRunInTransaction(
      tx,
      principal,
      common,
      hosts,
      host,
      invocation,
    );

  return reservation;
}
