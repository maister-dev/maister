import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { CompanySpecialistExecutionIdentityInput } from "./company-agent-context";
import type { DelegatedWorkRequest } from "@/lib/specialist-assignments/delegated-intake";
import type {
  SpecialistWorkRecord,
  AssignmentWorkTarget,
} from "@/lib/specialist-assignments/work-types";

import { eq, sql } from "drizzle-orm";

import { agentDefinitionSha256 } from "./activity-snapshot";
import { prepareCompanySpecialistRole } from "./company-agent-context";
import { requireCompanyRunCredentialOwner } from "./company-run-credential-owner";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";
import { readAuthorizedAssignmentInput } from "@/lib/specialist-assignments/context";
import { retainDelegatedWorkInTransaction } from "@/lib/specialist-assignments/delegated-intake";

type CompanyWorkTarget = Extract<
  AssignmentWorkTarget,
  { kind: "company_agent" | "company_flow" }
>;
type CompanyWorkAdmission =
  | Readonly<{
      kind: "bound";
      target: CompanyWorkTarget;
      receipt: { childRunId: string; status: string };
    }>
  | Readonly<{
      kind: "reserved";
      work: SpecialistWorkRecord;
      target: CompanyWorkTarget;
      context: CompanySpecialistExecutionIdentityInput;
    }>;

/** Recheck the current origin, exact receiving role and assignment budget on the Run allocation transaction. */
export async function prepareCompanyDelegatedReservation(
  tx: Db,
  request: DelegatedWorkRequest,
): Promise<CompanyWorkAdmission> {
  const { work } = await retainDelegatedWorkInTransaction(tx, request);
  const { target, parent } = work.definition;

  if (target.kind !== "company_agent" && target.kind !== "company_flow")
    throw new MaisterError(
      "CONFIG",
      "Select a reviewed company specialist or Flow",
    );
  const { binding, effective } = await prepareCompanySpecialistRole(tx, {
    companyId: target.companyId,
    bindingId: target.specialistBinding.id,
    bindingRevision: target.specialistBinding.revision,
  });
  const [receivingGrant] = (
    await tx.execute(sql`
        SELECT id FROM company_grants
        WHERE company_id=${target.companyId} AND principal_type='agent'
          AND principal_id=${binding.snapshot.agentId} AND action='assignments:read'
          AND revoked_at IS NULL FOR SHARE
      `)
  ).rows;

  if (
    !binding.snapshot.grantActions.includes("assignments:read") ||
    !receivingGrant
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "The receiving company specialist lacks current assignment read authority",
    );
  if (work.childRunId !== null) {
    const [child] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, work.childRunId));

    if (!child)
      throw new MaisterError("CRASH", "The bound delegated Run is unavailable");

    return {
      kind: "bound",
      target,
      receipt: { childRunId: work.childRunId, status: child.status },
    };
  }
  await admitDelegatedChild(tx, {
    parentRunId: parent.runId,
    assignmentBounds: work.bounds,
    reservedRunId: work.reservedRunId,
  });
  const owner = await requireCompanyRunCredentialOwner(tx, parent.runId);
  const authority = await authorizeCompanyUserAction(
    tx,
    owner.userId,
    target.companyId,
    "assignments:update",
  );
  const input = await readAuthorizedAssignmentInput(
    tx,
    {
      kind: "execution",
      runId: parent.runId,
      nodeAttemptId: parent.nodeAttemptId,
    },
    work.assignmentId,
    work.inputRevision,
  );

  if (
    binding.snapshotDigest !== target.specialistBinding.snapshotSha256 ||
    effective.parsed.id !== target.role.agentId ||
    effective.packageInstallId !== target.role.packageInstallId ||
    effective.resolvedRevision !== target.role.packageRevision ||
    agentDefinitionSha256(effective.parsed) !== target.role.definitionSha256 ||
    contentDigest(expandExecutionPolicy(binding.snapshot.executionPolicy)) !==
      contentDigest(
        expandExecutionPolicy(work.authoritySnapshot.executionPolicy),
      )
  )
    throw new MaisterError(
      "CONFLICT",
      "The company role or execution policy differs from the retained work",
      {
        details: { reason: "delegated_work_binding_changed" },
      },
    );
  const [head] = (
    await tx.execute(
      sql`SELECT revision FROM specialist_assignments WHERE id=${work.assignmentId}`,
    )
  ).rows;

  if (typeof head?.revision !== "number")
    throw new MaisterError(
      "CRASH",
      "The retained delegated assignment is unavailable",
    );

  return {
    kind: "reserved",
    work,
    target,
    context: {
      owner: { kind: "company", companyId: target.companyId },
      assignment: { id: work.assignmentId, revision: head.revision },
      input,
      binding,
      effective,
      authority,
    },
  };
}
