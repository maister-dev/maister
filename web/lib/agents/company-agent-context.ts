import "server-only";

import type { CompanyAgentExecutionSnapshot } from "./company-agent-execution-types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyUserAuthority } from "@/lib/company/authority";
import type { SpecialistIntakePrincipal } from "./installation-appointment";
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
import {
  assertInstallationAgentDefinition,
  assertStandaloneCompanyAgentDefinition,
} from "./company-agent-definition";
import { resolveAgentConfig } from "./config";
import { resolveInstalledAgentDefinition } from "./effective";
import { buildOperationalContract } from "./launch-contract";
import { assertInstallationAppointment } from "./installation-appointment";

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
export type CompanySpecialistContext = Readonly<{
  owner: Readonly<{ kind: "company"; companyId: string }>;
  assignment: SpecialistAssignment;
  input: AssignmentInputRevision;
  binding: CompanyBindingRevision;
  effective: EffectiveAgentDefinition;
  authority: CompanyUserAuthority;
}>;
export type CompanyAgentContext = CompanySpecialistContext;

/** Re-run inside admission's transaction; a previously returned context never authorizes a later effect. */
export async function prepareCompanySpecialistContext(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  value: unknown,
  lock = lockCompanyAssignmentForExecution,
): Promise<CompanySpecialistContext> {
  const parsed = companyAgentContextInputSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Company admission requires exact assignment, input and specialist configuration revisions",
      { details: { reason: "company_agent_context_invalid" } },
    );
  const request = parsed.data;

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
  const authority = await lock(tx, principal, request);
  const { binding, effective } = await prepareCompanySpecialistRole(
    tx,
    request,
  );
  const definition = effective.parsed;

  if (!definition.triggers.includes(request.triggerSource))
    throw new MaisterError(
      "CONFIG",
      "The pinned specialist does not declare this invocation trigger",
      { details: { reason: "company_agent_trigger_unsupported" } },
    );
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    principal,
    request.assignmentId,
  );
  const input = await getSpecialistAssignmentInputInTransaction(
    tx,
    principal,
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
  if (typeof principal === "string")
    for (const reference of input.snapshot.objectiveInput.inputRefs)
      await inspectKnowledgeEvidenceReference(
        tx,
        { kind: "user", userId: principal },
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
  log.debug(
    {
      companyId: request.companyId,
      assignmentId: assignment.id,
      bindingId: binding.bindingId,
      inputRevision: input.revision,
      bindingRevision: binding.revision,
      packageInstallId: effective.packageInstallId,
    },
    "company specialist input preflight passed",
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

/** Resolve the current reviewed installed role independently of the work owner. */
export async function prepareCompanySpecialistRole(
  tx: SqlTransaction,
  request: Pick<
    CompanyAgentContextInput,
    "companyId" | "bindingId" | "bindingRevision"
  >,
): Promise<Pick<CompanySpecialistContext, "binding" | "effective">> {
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

  if (
    effective.resolvedRevision !== binding.snapshot.packageRevision ||
    agentDefinitionSha256(effective.parsed) !==
      binding.snapshot.definitionSha256
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installed specialist does not match its reviewed package and definition witness",
      { details: { reason: "company_agent_pin_changed" } },
    );

  return { binding, effective };
}

/** Lock the business owner before any configuration, matching assignment transition order. */
export async function lockCompanyAssignmentForExecution(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  request: CompanyAgentContextInput,
): Promise<CompanyUserAuthority> {
  return lockCompanyExecutionHead(tx, principal, request, "queued");
}

export async function lockCompanyReplacementForExecution(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  request: CompanyAgentContextInput,
): Promise<CompanyUserAuthority> {
  if (typeof principal !== "string") throw unavailableAssignment();
  await authorizeCompanyUserAction(
    tx,
    principal,
    request.companyId,
    "assignments:recover",
  );

  return lockCompanyExecutionHead(tx, principal, request, "active");
}

async function lockCompanyExecutionHead(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  request: CompanyAgentContextInput,
  status: "queued" | "active",
): Promise<CompanyUserAuthority> {
  await beginAssignmentTransaction(tx);

  if (typeof principal === "string")
    await authorizeCompanyUserAction(
      tx,
      principal,
      request.companyId,
      "assignments:read",
    );
  const authority =
    typeof principal === "string"
      ? await authorizeCompanyUserAction(
          tx,
          principal,
          request.companyId,
          "assignments:update",
        )
      : principal.review.reviewer;
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
  if (typeof principal !== "string")
    assertInstallationAppointment(tx, principal, {
      companyId: head.company_id,
      bindingId: head.specialist_binding_id,
      origin: head.origin,
    });
  if (
    head.status !== status ||
    head.input_revision !== request.inputRevision ||
    head.specialist_binding_id !== request.bindingId
  )
    throw new MaisterError(
      "CONFLICT",
      "Company work changed or is unavailable for this specialist and input; inspect the assignment before admission",
      { details: { reason: "company_assignment_changed" } },
    );

  return authority;
}

/** Re-run inside admission; standalone sessions may not discard a declared coordinator. */
export async function prepareCompanyAgentContext(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  value: unknown,
): Promise<CompanyAgentContext> {
  const context = await prepareCompanySpecialistContext(tx, principal, value);

  return requireStandaloneContext(context);
}

export async function prepareCompanyAgentReplacementContext(
  tx: SqlTransaction,
  userId: string,
  value: CompanyAgentContextInput,
): Promise<CompanyAgentContext> {
  const context = await prepareCompanySpecialistContext(
    tx,
    userId,
    value,
    lockCompanyReplacementForExecution,
  );

  return requireStandaloneContext(context);
}

function requireStandaloneContext(
  context: CompanySpecialistContext,
): CompanyAgentContext {
  const { effective, binding, input } = context;
  const definition = effective.parsed;

  if (binding.snapshot.installationGrant)
    assertInstallationAgentDefinition(definition);
  else assertStandaloneCompanyAgentDefinition(definition);
  if (binding.snapshot.coordinatorFlowRevisionId !== null)
    throw new MaisterError(
      "CONFIG",
      "This specialist requires its exact company coordinator Flow admission",
      { details: { reason: "company_coordinator_required" } },
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

  return context;
}

export type CompanySpecialistExecutionIdentityInput = Omit<
  CompanySpecialistContext,
  "assignment"
> & { assignment: Pick<SpecialistAssignment, "id" | "revision"> };

/** Shared identity fields are captured from newly prepared server state, never converted from retained v1 bytes. */
export function captureCompanySpecialistExecutionIdentity(
  context: CompanySpecialistExecutionIdentityInput,
): Omit<CompanyAgentExecutionSnapshot, "schemaVersion"> {
  return {
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
    authority: companyAgentExecutionSnapshotSchema.shape.authority.parse(
      context.authority,
    ),
  };
}

/** Capture only validated server identities; do not use this historical receipt to authorize later actions. */
export function captureCompanyAgentExecution(
  context: CompanySpecialistExecutionIdentityInput,
): CompanyAgentExecutionSnapshot {
  return companyAgentExecutionSnapshotSchema.parse({
    schemaVersion: 1,
    ...captureCompanySpecialistExecutionIdentity(context),
  });
}
