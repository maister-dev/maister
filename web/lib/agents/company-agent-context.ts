import "server-only";

import type { CompanyAgentExecutionSnapshot } from "./company-agent-execution-types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyUserAuthority } from "@/lib/company/authority";
import type {
  AssignmentInputRevision,
  SpecialistAssignment,
} from "@/lib/specialist-assignments/types";
import type { CompanyBindingRevision } from "./company-binding-types";
import type { EffectiveAgentDefinition } from "./effective";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";
import { agentDefinitionSha256 } from "./activity-snapshot";
import {
  decodeCompanyBindingHead,
  loadCompanyBindingRevision,
} from "./company-bindings";
import { resolveAgentConfig } from "./config";
import { resolveInstalledAgentDefinition } from "./effective";
import { buildOperationalContract } from "./launch-contract";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import {
  beginAssignmentTransaction,
  unavailableAssignment,
  lockSpecialistAssignment,
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";
import { postgresTextSchema } from "@/lib/text-schema";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";

const log = pino({
  name: "agents:company-context",
  level: process.env.LOG_LEVEL ?? "info",
});
const identity = postgresTextSchema.min(1).max(128);

export const companyAgentContextInputSchema = z
  .object({
    companyId: identity,
    assignmentId: identity,
    assignmentRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    bindingId: identity,
    bindingRevision: knowledgeRevisionSchema,
    triggerSource: z.enum(["manual", "cron", "domain_event", "webhook"]),
  })
  .strict();
export type CompanyAgentContextInput = z.infer<
  typeof companyAgentContextInputSchema
>;
export type CompanyAgentContext = Readonly<{
  owner: Readonly<{ kind: "company"; companyId: string }>;
  assignment: SpecialistAssignment;
  input: AssignmentInputRevision;
  binding: CompanyBindingRevision;
  effective: EffectiveAgentDefinition;
  authority: CompanyUserAuthority;
}>;

/** Re-run inside admission's transaction; a previously returned context never authorizes a later effect. */
export async function prepareCompanyAgentContext(
  tx: SqlTransaction,
  userId: string,
  value: unknown,
): Promise<CompanyAgentContext> {
  const parsed = companyAgentContextInputSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Company admission requires exact assignment, input and specialist configuration revisions",
      { details: { reason: "company_agent_context_invalid" } },
    );
  const request = parsed.data;

  await beginAssignmentTransaction(tx);

  log.debug(
    {
      companyId: request.companyId,
      assignmentId: request.assignmentId,
      bindingId: request.bindingId,
      inputRevision: request.inputRevision,
      bindingRevision: request.bindingRevision,
    },
    "company agent preflight started",
  );
  await authorizeCompanyUserAction(
    tx,
    userId,
    request.companyId,
    "assignments:read",
  );
  const authority = await authorizeCompanyUserAction(
    tx,
    userId,
    request.companyId,
    "assignments:update",
  );
  const owned = (
    await tx.execute(
      sql`SELECT id FROM specialist_assignments WHERE id=${request.assignmentId} AND company_id=${request.companyId} AND project_id IS NULL FOR UPDATE`,
    )
  ).rows[0];

  if (!owned) throw unavailableAssignment();
  const head = await lockSpecialistAssignment(
    tx,
    request.assignmentId,
    request.assignmentRevision,
  );

  if (head.company_id !== request.companyId || head.project_id !== null)
    throw unavailableAssignment();
  if (
    head.status !== "queued" ||
    head.input_revision !== request.inputRevision ||
    head.specialist_binding_id !== request.bindingId
  )
    throw new MaisterError(
      "CONFLICT",
      "Company work changed or is not queued for this specialist and input; inspect the assignment before admission",
      { details: { reason: "company_assignment_changed" } },
    );
  const bindingHead = decodeCompanyBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_specialist_bindings WHERE id=${request.bindingId} AND company_id=${request.companyId} FOR SHARE`,
      )
    ).rows[0],
  );

  if (bindingHead.revision !== request.bindingRevision)
    throw new MaisterError(
      "CONFLICT",
      "Specialist configuration changed; inspect its current revision before admission",
      { details: { reason: "company_binding_revision_conflict" } },
    );
  const binding = await loadCompanyBindingRevision(
    tx,
    bindingHead,
    request.bindingRevision,
  );

  if (!binding.snapshot.enabled || binding.snapshot.detachedAt !== null)
    throw new MaisterError(
      "PRECONDITION",
      "Company specialist is disabled or retired",
      { details: { reason: "company_binding_disabled" } },
    );

  const catalog = (
    await tx.execute(
      sql`SELECT enabled,quarantined_at FROM agents WHERE id=${bindingHead.agentId} FOR SHARE`,
    )
  ).rows[0];

  if (!catalog || catalog.enabled !== true || catalog.quarantined_at !== null)
    throw new MaisterError(
      "PRECONDITION",
      "Specialist catalog identity is unavailable, disabled or quarantined",
      { details: { reason: "company_agent_unavailable" } },
    );
  const effective = await resolveInstalledAgentDefinition(tx, {
    agentId: bindingHead.agentId,
    packageInstallId: binding.snapshot.packageInstallId,
  });
  const definition = effective.parsed;

  if (
    effective.resolvedRevision !== binding.snapshot.packageRevision ||
    agentDefinitionSha256(definition) !== binding.snapshot.definitionSha256
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installed specialist does not match its reviewed package and definition witness",
      { details: { reason: "company_agent_pin_changed" } },
    );
  if (
    definition.workspace !== "none" ||
    definition.workspaceRef !== null ||
    definition.taskQualification !== null ||
    definition.mode !== "session" ||
    definition.riskTier === "destructive"
  )
    throw new MaisterError(
      "CONFIG",
      "Standalone company sessions require a finite workspace-none role without repository qualification",
      { details: { reason: "company_agent_workspace_unsupported" } },
    );
  if (
    definition.memory !== "none" ||
    (definition.capabilityProfile?.mcps?.length ?? 0) > 0
  )
    throw new MaisterError(
      "CONFIG",
      "Company sessions require native knowledge tools; project memory and project MCP bindings require explicit project admission",
      {
        details: { reason: "company_agent_project_capability_unsupported" },
      },
    );
  if (
    definition.flow !== null ||
    binding.snapshot.coordinatorFlowRevisionId !== null
  )
    throw new MaisterError(
      "CONFIG",
      "This specialist requires its exact company coordinator Flow admission",
      { details: { reason: "company_coordinator_required" } },
    );
  if (!definition.triggers.includes(request.triggerSource))
    throw new MaisterError(
      "CONFIG",
      "The pinned specialist does not declare this invocation trigger",
      { details: { reason: "company_agent_trigger_unsupported" } },
    );
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    userId,
    request.assignmentId,
  );
  const input = await getSpecialistAssignmentInputInTransaction(
    tx,
    userId,
    request.assignmentId,
    request.inputRevision,
  );
  const standing = input.snapshot.standingDefinition;

  if (
    contentDigest(
      expandExecutionPolicy(input.snapshot.authoritySnapshot.executionPolicy),
    ) !== contentDigest(expandExecutionPolicy(binding.snapshot.executionPolicy))
  )
    throw new MaisterError(
      "CONFIG",
      "Assignment execution policy differs from the reviewed specialist policy; review and update the requested authority before admission",
      { details: { reason: "company_assignment_policy_mismatch" } },
    );
  for (const reference of input.snapshot.objectiveInput.inputRefs)
    await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "user", userId },
      reference,
    );

  if (
    standing.agentId !== definition.id ||
    standing.packageInstallId !== effective.packageInstallId ||
    standing.packageRevision !== effective.resolvedRevision ||
    standing.definitionSha256 !== binding.snapshot.definitionSha256 ||
    contentDigest(
      resolveAgentConfig(definition.config, standing.configuration),
    ) !== contentDigest(binding.snapshot.effectiveConfiguration)
  )
    throw new MaisterError(
      "CONFLICT",
      "Assignment standing input differs from this specialist configuration; update the requested work explicitly",
      { details: { reason: "company_assignment_standing_changed" } },
    );
  const result = buildOperationalContract(effective);

  if (
    contentDigest(input.snapshot.objectiveInput.expectedResult) !==
    contentDigest({
      schemaRef: result.schemaRef,
      schemaVersion: result.schemaVersion,
      sha256: result.sha256,
      required: true,
    })
  )
    throw new MaisterError(
      "CONFIG",
      "Assignment requires a different result contract from this pinned specialist",
      { details: { reason: "company_assignment_result_mismatch" } },
    );
  log.debug(
    {
      companyId: request.companyId,
      assignmentId: assignment.id,
      bindingId: binding.bindingId,
      inputRevision: input.revision,
      bindingRevision: binding.revision,
      packageInstallId: effective.packageInstallId,
    },
    "company agent preflight passed",
  );

  return {
    owner: { kind: "company", companyId: request.companyId },
    assignment,
    input,
    binding,
    effective,
    authority,
  };
}

/** Capture only validated server identities; do not use this historical receipt to authorize later actions. */
export function captureCompanyAgentExecution(
  context: CompanyAgentContext,
): CompanyAgentExecutionSnapshot {
  return companyAgentExecutionSnapshotSchema.parse({
    schemaVersion: 1,
    owner: context.owner,
    assignmentRevision: context.assignment.revision,
    assignment: {
      id: context.assignment.id,
      inputRevision: context.input.revision,
      inputSha256: context.input.digest,
    },
    specialistBinding: {
      id: context.binding.bindingId,
      revision: context.binding.revision,
      snapshotSha256: context.binding.snapshotDigest,
    },
    authority: context.authority,
  });
}
