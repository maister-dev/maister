import "server-only";

import type { z } from "zod";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type {
  CompanySpecialistContext,
  CompanySpecialistExecutionIdentityInput,
} from "./company-agent-context";
import type { CompanyFlowBindingRevision } from "./company-flow-binding-types";
import type { CompanyFlowExecutionSnapshot } from "./company-execution-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  captureCompanySpecialistExecutionIdentity,
  companyAgentContextInputSchema,
  lockCompanyAssignmentForExecution,
  prepareCompanySpecialistContext,
} from "./company-agent-context";
import { assertCompanySessionDefinition } from "./company-agent-definition";
import { captureCompanyFlowBinding } from "./company-flow-binding-capture";
import {
  decodeCompanyFlowBindingHead,
  loadCompanyFlowBindingRevision,
} from "./company-flow-bindings";
import { companyFlowExecutionSnapshotSchema } from "./company-execution-types";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { validateGraphManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "agents:company-flow-context",
  level: process.env.LOG_LEVEL ?? "info",
});

export const companyFlowContextInputSchema = companyAgentContextInputSchema
  .extend({
    coordinatorBindingId: postgresTextSchema.min(1).max(128),
    coordinatorBindingRevision: knowledgeRevisionSchema,
  })
  .strict();

export type CompanyFlowContextInput = z.infer<
  typeof companyFlowContextInputSchema
>;
export type CompanyFlowAdmissionContext = CompanySpecialistContext &
  Readonly<{
    coordinator: CompanyFlowBindingRevision;
    resultContract: Extract<RunResultContract, { kind: "flow_export" }>;
    flowInstallPath: string;
    flowVersion: string;
    flowDefaultRunnerId: string | null;
  }>;

/** Current exact pins and authority are checked again inside native reservation; this inspection creates no execution. */
export async function prepareCompanyFlowContext(
  tx: SqlTransaction,
  userId: string,
  value: unknown,
): Promise<CompanyFlowAdmissionContext> {
  const parsed = companyFlowContextInputSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Company coordinator admission requires exact assignment, specialist and Flow configuration revisions",
      {
        details: { reason: "company_flow_context_invalid" },
      },
    );
  const { coordinatorBindingId, coordinatorBindingRevision, ...request } =
    parsed.data;

  await lockCompanyAssignmentForExecution(tx, userId, request);
  const coordinator = await loadReviewedCompanyCoordinator(tx, parsed.data);
  const context = await prepareCompanySpecialistContext(tx, userId, request);
  const flow = await resolveReviewedCompanyFlowSource(tx, context, coordinator);
  const { resultContract } = flow;

  if (
    contentDigest(context.input.snapshot.objectiveInput.expectedResult) !==
    contentDigest({
      schemaRef: resultContract.schemaRef,
      schemaVersion: resultContract.schemaVersion,
      sha256: resultContract.sha256,
      required: true,
    })
  )
    throw new MaisterError(
      "CONFIG",
      "Assignment requires a different result contract from this pinned coordinator Flow",
      {
        details: { reason: "company_assignment_result_mismatch" },
      },
    );
  log.debug(
    {
      companyId: request.companyId,
      assignmentId: request.assignmentId,
      inputRevision: request.inputRevision,
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
      coordinatorBindingId,
      coordinatorBindingRevision,
      flowRevisionId: coordinator.snapshot.flowRevisionId,
    },
    "company coordinator preflight passed",
  );

  return { ...context, ...flow };
}

/** Resolve current coordinator configuration under the caller's owner fence. */
export async function loadReviewedCompanyCoordinator(
  tx: SqlTransaction,
  request: Pick<
    CompanyFlowContextInput,
    | "companyId"
    | "bindingId"
    | "bindingRevision"
    | "coordinatorBindingId"
    | "coordinatorBindingRevision"
  >,
): Promise<CompanyFlowBindingRevision> {
  const { coordinatorBindingId, coordinatorBindingRevision } = request;
  const head = decodeCompanyFlowBindingHead(
    (
      await tx.execute(sql`
    SELECT * FROM company_flow_bindings
    WHERE id=${coordinatorBindingId} AND company_id=${request.companyId} FOR SHARE
  `)
    ).rows[0],
  );

  if (head.revision !== coordinatorBindingRevision)
    throw new MaisterError(
      "CONFLICT",
      "Coordinator configuration changed; inspect its current revision before admission",
      {
        details: { reason: "company_flow_binding_revision_conflict" },
      },
    );
  const coordinator = await loadCompanyFlowBindingRevision(
    tx,
    head,
    head.revision,
  );
  const reviewed = coordinator.snapshot;

  if (!reviewed.enabled || reviewed.detachedAt !== null)
    throw new MaisterError(
      "PRECONDITION",
      "Company coordinator is disabled or retired",
      {
        details: { reason: "company_flow_binding_disabled" },
      },
    );
  if (
    reviewed.specialistBindingId !== request.bindingId ||
    reviewed.specialistRevision !== request.bindingRevision
  )
    throw new MaisterError(
      "CONFLICT",
      "The coordinator does not reference this exact responsible specialist configuration",
      {
        details: { reason: "company_flow_specialist_mismatch" },
      },
    );

  return coordinator;
}

export type ReviewedCompanyFlowSource = Pick<
  CompanyFlowAdmissionContext,
  | "coordinator"
  | "resultContract"
  | "flowInstallPath"
  | "flowVersion"
  | "flowDefaultRunnerId"
>;

/** Resolve the installed manifest, routing and required export of the exact reviewed Flow. */
export async function resolveReviewedCompanyFlowSource(
  tx: SqlTransaction,
  context: Pick<CompanySpecialistContext, "owner" | "binding" | "effective">,
  coordinator: CompanyFlowBindingRevision,
): Promise<ReviewedCompanyFlowSource> {
  const reviewed = coordinator.snapshot;

  assertCompanySessionDefinition(context.effective.parsed);
  if (
    context.effective.parsed.flow !== reviewed.flowRefId ||
    context.binding.snapshot.coordinatorFlowRevisionId !==
      reviewed.flowRevisionId
  )
    throw new MaisterError(
      "CONFLICT",
      "The specialist and reviewed coordinator must pin the same installed Flow",
      {
        details: { reason: "company_flow_pin_mismatch" },
      },
    );
  // Reuse the configuration capturer's exact package membership, current provider,
  // role mapping and engine checks. Its fresh routing witness does not rewrite history.
  const current = await captureCompanyFlowBinding(tx, {
    owner: context.owner,
    specialistBindingId: context.binding.bindingId,
    specialistRevision: context.binding.revision,
    flowRevisionId: reviewed.flowRevisionId,
    manifestSha256: reviewed.manifestSha256,
    execution: reviewed.execution,
    enabled: true,
    roleMappings: reviewed.roleMappings,
    idempotencyKey: "internal:company-flow-preflight",
  });

  validateGraphManifest(
    current.manifest,
    current.manifest.nodes,
    "company coordinator Flow",
  );
  compileManifest(current.manifest);
  const revision = (
    await tx.execute(sql`
    SELECT installed_path,resolved_revision,version_label,default_runner_id FROM flow_revisions
    WHERE id=${reviewed.flowRevisionId} AND package_status='Installed' AND exec_trust='trusted' FOR SHARE
  `)
  ).rows[0];

  if (
    typeof revision?.installed_path !== "string" ||
    typeof revision.resolved_revision !== "string" ||
    typeof revision.version_label !== "string" ||
    (revision.default_runner_id !== null &&
      typeof revision.default_runner_id !== "string")
  )
    throw new MaisterError(
      "PRECONDITION",
      "The pinned company coordinator revision is unavailable",
    );
  const resultContract = await resolveFlowExportContract({
    flowRefId: reviewed.flowRefId,
    manifest: current.manifest,
    revision: {
      id: reviewed.flowRevisionId,
      installedPath: revision.installed_path,
      resolvedRevision: revision.resolved_revision,
    },
  });

  if (resultContract?.kind !== "flow_export" || !resultContract.required)
    throw new MaisterError(
      "CONFIG",
      "The reviewed company Flow requires a pinned required export",
    );

  return {
    coordinator,
    resultContract,
    flowInstallPath: revision.installed_path,
    flowVersion: revision.version_label,
    flowDefaultRunnerId: revision.default_runner_id,
  };
}

/** The server preserves exact reviewed witnesses; accepting this capture grants no future authority. */
export function captureCompanyFlowExecution(
  context: CompanySpecialistExecutionIdentityInput & ReviewedCompanyFlowSource,
): CompanyFlowExecutionSnapshot {
  return companyFlowExecutionSnapshotSchema.parse({
    ...captureCompanySpecialistExecutionIdentity(context),
    schemaVersion: 2,
    executionKind: "flow",
    coordinatorFlowBinding: {
      id: context.coordinator.bindingId,
      revision: context.coordinator.revision,
      snapshotSha256: context.coordinator.snapshotDigest,
    },
  });
}
