import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyBindingRevision } from "@/lib/agents/company-binding-types";
import type { CompanyBindingHead } from "@/lib/agents/company-bindings";
import type { CompanyFlowBindingHead } from "@/lib/agents/company-flow-bindings";
import type { CompanyFlowBindingRevision } from "@/lib/agents/company-flow-binding-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type {
  AssignmentOrigin,
  AssignmentResultExpectation,
  PreparedSpecialistAssignment,
} from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import {
  intakeSpecialistAssignmentInTransaction,
  inspectSpecialistIntakeReplayInTransaction,
} from "./intake";
import { getSpecialistAssignmentInTransaction } from "./store";
import { wakePendingSpecialistAssignment } from "./admission-wake";

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
import { reserveCompanyAgentRunInTransaction } from "@/lib/agents/company-agent-launch";
import { reserveCompanyFlowRunInTransaction } from "@/lib/agents/company-flow-launch";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { ownerSchema } from "@/lib/company/types";
import { redactQueryError } from "@/lib/db/pg-error";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, localHost } from "@/lib/execution-host";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";

export const companyManualAssignmentRequestSchema =
  manualSpecialistAssignmentRequestSchema
    .extend({
      owner: ownerSchema.options[0],
    })
    .strict();
type CompanyManualAssignmentRequest = z.infer<
  typeof companyManualAssignmentRequestSchema
>;
type ReviewedManualSpecialist = Readonly<{
  head: CompanyBindingHead;
  revision: CompanyBindingRevision;
}>;
type ReviewedManualCoordinator = Readonly<{
  head: CompanyFlowBindingHead;
  revision: CompanyFlowBindingRevision;
}>;

const log = pino({
  name: "company-manual-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

async function loadManualSpecialist(
  tx: SqlTransaction,
  request: CompanyManualAssignmentRequest,
): Promise<ReviewedManualSpecialist> {
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

async function loadManualCoordinator(
  tx: SqlTransaction,
  companyId: string,
  specialist: ReviewedManualSpecialist,
): Promise<ReviewedManualCoordinator> {
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

async function prepareManualCompanyAssignment(
  tx: SqlTransaction,
  userId: string,
  request: CompanyManualAssignmentRequest,
  origin: AssignmentOrigin,
): Promise<PreparedSpecialistAssignment> {
  for (const action of [
    "assignments:read",
    "assignments:submit",
    "assignments:update",
  ] as const)
    await authorizeCompanyUserAction(
      tx,
      userId,
      request.owner.companyId,
      action,
    );
  const specialist = await loadManualSpecialist(tx, request);
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
    const coordinator = await loadManualCoordinator(
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
  const {
    owner,
    specialistBindingId,
    idempotencyKey: _key,
    ...objectiveInput
  } = request;

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
    scheduledRequest: null,
    sourceRestrictions: [],
    executionPolicy: snapshot.executionPolicy,
    origin,
    destination: { kind: "inbox", userId },
  };
}

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
          prepareManualCompanyAssignment(sourceTx, userId, request, origin),
      );

      if (receipt.duplicate) return receipt;
      const specialist = await loadManualSpecialist(tx, request);
      const common = {
        companyId: request.owner.companyId,
        assignmentId: receipt.assignment.id,
        assignmentRevision: receipt.assignment.revision,
        inputRevision: receipt.inputRevision,
        bindingId: specialist.head.id,
        bindingRevision: specialist.head.revision,
        triggerSource: "manual" as const,
      };
      let reservation: Awaited<
        ReturnType<typeof reserveCompanyAgentRunInTransaction>
      >;

      if (specialist.revision.snapshot.definition.flow) {
        const coordinator = await loadManualCoordinator(
          tx,
          request.owner.companyId,
          specialist,
        );

        reservation = await reserveCompanyFlowRunInTransaction(
          tx,
          userId,
          {
            ...common,
            coordinatorBindingId: coordinator.head.id,
            coordinatorBindingRevision: coordinator.head.revision,
          },
          hosts,
          host,
        );
      } else
        reservation = await reserveCompanyAgentRunInTransaction(
          tx,
          userId,
          common,
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
