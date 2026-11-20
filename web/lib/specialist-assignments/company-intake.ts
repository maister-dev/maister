import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyBindingRevision } from "@/lib/agents/company-binding-types";
import type { CompanyBindingHead } from "@/lib/agents/company-bindings";
import type { CompanyFlowBindingHead } from "@/lib/agents/company-flow-bindings";
import type { CompanyFlowBindingRevision } from "@/lib/agents/company-flow-binding-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { Owner } from "@/lib/company/types";
import type { SpecialistIntakeRequest } from "./intake-types";
import type {
  AssignmentOrigin,
  AssignmentResultExpectation,
  PreparedSpecialistAssignment,
} from "./types";

import { sql } from "drizzle-orm";

import {
  decodeCompanyBindingHead,
  loadCompanyBindingRevision,
} from "@/lib/agents/company-bindings";
import {
  decodeCompanyFlowBindingHead,
  loadCompanyFlowBindingRevision,
} from "@/lib/agents/company-flow-bindings";
import { resolveInstalledAgentDefinition } from "@/lib/agents/effective";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  assertInstallationAppointment,
  type SpecialistIntakePrincipal,
} from "@/lib/agents/installation-appointment";
import { MaisterError } from "@/lib/errors";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";

export type CompanyAssignmentRequest = Omit<SpecialistIntakeRequest, "owner"> &
  Readonly<{ owner: Extract<Owner, { kind: "company" }> }>;
export type CompanyAssignmentInvocation = Readonly<{
  origin: AssignmentOrigin;
  destination: PreparedSpecialistAssignment["destination"];
  scheduledRequest: PreparedSpecialistAssignment["scheduledRequest"];
}>;
type ReviewedCompanySpecialist = Readonly<{
  head: CompanyBindingHead;
  revision: CompanyBindingRevision;
}>;
type ReviewedCompanyCoordinator = Readonly<{
  head: CompanyFlowBindingHead;
  revision: CompanyFlowBindingRevision;
}>;

export async function loadCompanyAssignmentSpecialist(
  tx: SqlTransaction,
  request: Pick<CompanyAssignmentRequest, "owner" | "specialistBindingId">,
): Promise<ReviewedCompanySpecialist> {
  const head = decodeCompanyBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_specialist_bindings WHERE id=${request.specialistBindingId} AND company_id=${request.owner.companyId} FOR SHARE`,
      )
    ).rows[0],
  );
  const revision = await loadCompanyBindingRevision(tx, head, head.revision);

  if (!revision.snapshot.enabled || revision.snapshot.detachedAt !== null)
    throw new MaisterError(
      "PRECONDITION",
      "Company specialist is disabled or retired",
      { details: { reason: "company_binding_disabled" } },
    );

  return { head, revision };
}

export async function loadCompanyAssignmentCoordinator(
  tx: SqlTransaction,
  companyId: string,
  specialist: ReviewedCompanySpecialist,
): Promise<ReviewedCompanyCoordinator> {
  const definition = specialist.revision.snapshot.definition;

  if (!definition.flow)
    throw new MaisterError(
      "CONFIG",
      "The specialist does not declare a coordinator Flow",
    );
  const head = decodeCompanyFlowBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_flow_bindings WHERE company_id=${companyId} AND flow_ref_id=${definition.flow} FOR SHARE`,
      )
    ).rows[0],
  );
  const revision = await loadCompanyFlowBindingRevision(
    tx,
    head,
    head.revision,
  );
  const snapshot = revision.snapshot;

  if (!snapshot.enabled || snapshot.detachedAt !== null)
    throw new MaisterError(
      "PRECONDITION",
      "Company coordinator is disabled or retired",
      { details: { reason: "company_flow_binding_disabled" } },
    );
  if (
    snapshot.specialistBindingId !== specialist.head.id ||
    snapshot.specialistRevision !== specialist.head.revision ||
    snapshot.flowRevisionId !==
      specialist.revision.snapshot.coordinatorFlowRevisionId
  )
    throw new MaisterError(
      "CONFLICT",
      "The coordinator must reference this exact reviewed specialist and Flow pin",
      { details: { reason: "company_flow_specialist_mismatch" } },
    );

  return { head, revision };
}

function assignmentResult(
  contract: RunResultContract | null,
): AssignmentResultExpectation {
  if (!contract || contract.required !== true)
    throw new MaisterError(
      "PRECONDITION",
      "Specialist work requires an exact mandatory result contract",
    );

  return {
    schemaRef: contract.schemaRef,
    schemaVersion: contract.schemaVersion,
    sha256: contract.sha256,
    required: true,
  };
}

export async function prepareCompanySpecialistAssignment(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  request: CompanyAssignmentRequest,
  invocation: CompanyAssignmentInvocation,
): Promise<PreparedSpecialistAssignment> {
  if (typeof principal !== "string")
    assertInstallationAppointment(tx, principal, {
      companyId: request.owner.companyId,
      bindingId: request.specialistBindingId,
      origin: invocation.origin,
    });
  else
    for (const action of [
      "assignments:read",
      "assignments:submit",
      "assignments:update",
    ] as const)
      await authorizeCompanyUserAction(
        tx,
        principal,
        request.owner.companyId,
        action,
      );
  const specialist = await loadCompanyAssignmentSpecialist(tx, request);
  const snapshot = specialist.revision.snapshot;
  const effective = await resolveInstalledAgentDefinition(tx, {
    agentId: specialist.head.agentId,
    packageInstallId: snapshot.packageInstallId,
  });

  if (
    effective.resolvedRevision !== snapshot.packageRevision ||
    agentDefinitionSha256(effective.parsed) !== snapshot.definitionSha256
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installed specialist differs from its reviewed package and definition witness",
    );
  let expectedResult: AssignmentResultExpectation;

  if (effective.parsed.flow) {
    const coordinator = await loadCompanyAssignmentCoordinator(
      tx,
      request.owner.companyId,
      specialist,
    );
    const provider = coordinator.revision.snapshot;
    const revision = (
      await tx.execute(
        sql`SELECT installed_path,resolved_revision FROM flow_revisions WHERE id=${provider.flowRevisionId} AND package_status='Installed' AND exec_trust='trusted' FOR SHARE`,
      )
    ).rows[0];

    if (
      typeof revision?.installed_path !== "string" ||
      typeof revision.resolved_revision !== "string"
    )
      throw new MaisterError(
        "PRECONDITION",
        "The exact installed company coordinator is unavailable",
      );
    expectedResult = assignmentResult(
      await resolveFlowExportContract({
        flowRefId: provider.flowRefId,
        manifest: provider.manifest,
        revision: {
          id: provider.flowRevisionId,
          installedPath: revision.installed_path,
          resolvedRevision: revision.resolved_revision,
        },
      }),
    );
  } else expectedResult = assignmentResult(buildOperationalContract(effective));
  const { owner, specialistBindingId, ...objectiveInput } = request;

  return {
    owner,
    specialistBindingId,
    responsibleAgentId: snapshot.agentId,
    objectiveInput: { ...objectiveInput, expectedResult },
    standingDefinition: {
      schemaVersion: 1,
      agentId: snapshot.agentId,
      packageInstallId: snapshot.packageInstallId,
      packageName: snapshot.packageName,
      packageRevision: snapshot.packageRevision,
      definitionSha256: snapshot.definitionSha256,
      definition: effective.parsed,
      configuration: snapshot.effectiveConfiguration,
    },
    scheduledRequest: invocation.scheduledRequest,
    sourceRestrictions: [],
    executionPolicy: snapshot.executionPolicy,
    origin: invocation.origin,
    destination: invocation.destination,
  };
}
