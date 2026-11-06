import "server-only";

import type { z } from "zod";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { CompanySpecialistContext } from "./company-agent-context";
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
  const context = await prepareCompanySpecialistContext(tx, userId, request);

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
    SELECT installed_path,resolved_revision FROM flow_revisions
    WHERE id=${reviewed.flowRevisionId} AND package_status='Installed' AND exec_trust='trusted' FOR SHARE
  `)
  ).rows[0];

  if (
    typeof revision?.installed_path !== "string" ||
    typeof revision.resolved_revision !== "string"
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

  if (
    resultContract?.kind !== "flow_export" ||
    resultContract.required !== true ||
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
      flowRevisionId: reviewed.flowRevisionId,
    },
    "company coordinator preflight passed",
  );

  return {
    ...context,
    coordinator,
    resultContract,
    flowInstallPath: revision.installed_path,
  };
}

/** The server preserves exact reviewed witnesses; accepting this capture grants no future authority. */
export function captureCompanyFlowExecution(
  context: CompanyFlowAdmissionContext,
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
