import "server-only";

import type { SQL } from "drizzle-orm";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyAction, NativeKnowledgeActor } from "@/lib/company/types";
import type { CompanyExecutionSnapshot } from "./company-execution-types";
import type { CompanySpecialistBindingSnapshot } from "./company-binding-types";
import type { AssignmentWorkDefinition } from "@/lib/specialist-assignments/work-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { companyExecutionSnapshotSchema } from "./company-execution-types";
import { companySpecialistBindingSnapshotSchema } from "./company-binding-snapshot";
import { assertCompanySessionDefinition } from "./company-agent-definition";
import { bindingActionSubsetSchema } from "./company-binding-types";

import { currentKnowledgeNodeAttemptPolicy } from "@/lib/brain/knowledge-node-policy";
import { nativeKnowledgeActorSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { assignmentWorkDefinitionSchema } from "@/lib/specialist-assignments/work-types";

const log = pino({
  name: "agents:company-run-authority",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyRunCredentialOwner = Readonly<{
  companyId: string;
  runId: string;
  agentId: string;
  userId: string;
  actionLimits: readonly CompanyAction[];
  bindingId: string;
  snapshot: CompanyExecutionSnapshot;
  professionalRole: NativeKnowledgeActor;
  delegated?: Readonly<{
    definition: AssignmentWorkDefinition;
    binding: CompanySpecialistBindingSnapshot;
  }>;
}>;

function companyRunOwnerQuery(runId: string): SQL {
  return sql`
    SELECT execution.run_kind,execution.company_id,execution.source_agent_id,execution.company_execution_snapshot,configuration.snapshot->'grantActions' AS action_limits,jsonb_build_object('schemaVersion',1,'agentId',binding.agent_id,'packageInstallId',package.id,'packageName',package.name,'definitionSha256',configuration.snapshot->>'definitionSha256') AS professional_role,
      work.definition AS delegated_definition,configuration.snapshot AS binding_snapshot
    FROM runs execution
    JOIN specialist_run_links link ON link.run_id=execution.id
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id AND assignment.project_id IS NULL
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision
    LEFT JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
      AND work.assignment_id=assignment.id AND work.input_revision=input.revision AND work.input_sha256=input.digest
      AND work.child_run_id=execution.id AND work.reserved_run_id=execution.id AND work.parent_run_id=execution.parent_run_id
    JOIN company_specialist_bindings binding ON binding.id=(CASE WHEN link.work_id IS NULL
      THEN assignment.specialist_binding_id ELSE work.definition->'target'->'specialistBinding'->>'id' END)
      AND binding.company_id=execution.company_id AND binding.enabled AND binding.detached_at IS NULL
    JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
    JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    JOIN users principal ON principal.id=execution.company_execution_snapshot->'authority'->'actor'->>'id' AND principal.account_status='active' AND NOT principal.must_change_password
    JOIN company_grants read_grant ON read_grant.company_id=execution.company_id AND read_grant.principal_type='user' AND read_grant.principal_id=principal.id AND read_grant.action='assignments:read' AND read_grant.revoked_at IS NULL
    WHERE execution.id=${runId} AND execution.company_id IS NOT NULL AND execution.project_id IS NULL AND (
        (execution.run_kind='agent' AND execution.company_execution_snapshot->>'schemaVersion'='1' AND (
          link.work_id IS NULL OR (link.role='child' AND work.decision_state='open'
            AND work.definition->'target'->>'kind'='company_agent'
            AND specialist_run_has_input(execution.id,assignment.id,input.revision,input.digest)
            AND specialist_work_target_exists(work.definition->'target',execution.company_id,NULL)
            AND configuration.snapshot->'grantActions' ? 'assignments:read'
            AND EXISTS (
              SELECT 1 FROM company_grants receiving_grant
              WHERE receiving_grant.company_id=execution.company_id AND receiving_grant.principal_type='agent'
                AND receiving_grant.principal_id=binding.agent_id AND receiving_grant.action='assignments:read'
                AND receiving_grant.revoked_at IS NULL FOR SHARE
            )
          )
        ))
        OR (execution.run_kind='flow' AND execution.company_execution_snapshot->>'schemaVersion'='2' AND link.role='coordinator'
          AND EXISTS (
            SELECT 1 FROM company_flow_bindings coordinator
            JOIN company_flow_binding_revisions reviewed ON reviewed.binding_id=coordinator.id AND reviewed.revision=coordinator.revision
            JOIN flow_revisions flow ON flow.id=coordinator.flow_revision_id AND flow.package_status='Installed' AND flow.exec_trust='trusted'
            WHERE coordinator.company_id=execution.company_id AND coordinator.enabled AND coordinator.detached_at IS NULL
              AND coordinator.specialist_binding_id=binding.id AND coordinator.package_install_id=package.id
              AND coordinator.id=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'id'
              AND coordinator.revision::text=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'revision'
              AND reviewed.snapshot_digest=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'snapshotSha256'
              AND flow.id=execution.flow_revision_id AND flow.resolved_revision=execution.flow_revision
              AND flow.manifest_digest=reviewed.snapshot->>'manifestSha256'
            FOR SHARE OF coordinator,reviewed,flow
          ))
      )
      AND assignment.status NOT IN ('completed','failed','cancelled')
      AND assignment.id=execution.company_execution_snapshot->'assignment'->>'id'
      AND input.revision::numeric=(execution.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND input.digest=execution.company_execution_snapshot->'assignment'->>'inputSha256'
      AND binding.id=execution.company_execution_snapshot->'specialistBinding'->>'id'
      AND binding.revision::numeric=(execution.company_execution_snapshot->'specialistBinding'->>'revision')::numeric
      AND configuration.snapshot_digest=execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'
      AND binding.agent_id=execution.source_agent_id
      AND package.resolved_revision=configuration.snapshot->>'packageRevision'
  `;
}

function decodeCompanyRunOwner(
  row: Readonly<Record<string, unknown>> | undefined,
  runId: string,
): CompanyRunCredentialOwner {
  const snapshot = companyExecutionSnapshotSchema.safeParse(
    row?.company_execution_snapshot,
  );
  const actions = bindingActionSubsetSchema.safeParse(row?.action_limits);
  const professional = nativeKnowledgeActorSchema.safeParse(
    row?.professional_role,
  );
  let delegated: CompanyRunCredentialOwner["delegated"];

  if (
    !row ||
    !snapshot.success ||
    !actions.success ||
    !professional.success ||
    (snapshot.data.schemaVersion === 2
      ? row.run_kind !== "flow"
      : row.run_kind !== "agent") ||
    row.company_id !== snapshot.data.owner.companyId ||
    row.source_agent_id !== professional.data.agentId
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current company agent runtime authority is unavailable",
      { details: { reason: "company_agent_runtime_unavailable" } },
    );
  if (row.delegated_definition !== null) {
    const definition = assignmentWorkDefinitionSchema.safeParse(
      row.delegated_definition,
    );
    const binding = companySpecialistBindingSnapshotSchema.safeParse(
      row.binding_snapshot,
    );

    if (!definition.success || !binding.success)
      throw new MaisterError(
        "CONFIG",
        "The exact delegated company role or work definition is invalid",
      );
    delegated = { definition: definition.data, binding: binding.data };
  }

  return {
    companyId: snapshot.data.owner.companyId,
    runId,
    agentId: professional.data.agentId,
    userId: snapshot.data.authority.actor.id,
    actionLimits: actions.data,
    bindingId: snapshot.data.specialistBinding.id,
    snapshot: snapshot.data,
    professionalRole: professional.data,
    ...(delegated && { delegated }),
  };
}

/** Credential verification requires an active execution and current read authority. */
export async function requireCompanyRunCredentialOwner(
  tx: SqlTransaction,
  runId: string,
): Promise<CompanyRunCredentialOwner> {
  const row = (
    await tx.execute(
      sql`${companyRunOwnerQuery(runId)} AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking') FOR SHARE OF execution,assignment,binding,package,catalog,principal,read_grant`,
    )
  ).rows[0];

  return decodeCompanyRunOwner(row, runId);
}

/** Server-only inspection may validate an exact Pending reservation before exposing its first prompt. */
export async function requireCompanyKnowledgeRunOwner(
  tx: SqlTransaction,
  runId: string,
): Promise<CompanyRunCredentialOwner> {
  const row = (
    await tx.execute(
      sql`${companyRunOwnerQuery(runId)} AND execution.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking') FOR SHARE OF execution,assignment,binding,package,catalog,principal,read_grant`,
    )
  ).rows[0];

  return decodeCompanyRunOwner(row, runId);
}

/** A Flow persona requires its own exact current reviewed company binding, never inherited identity. */
export async function requireCompanyFlowProfessionalRole(
  tx: SqlTransaction,
  owner: CompanyRunCredentialOwner,
  actor: NativeKnowledgeActor,
): Promise<
  Readonly<{
    bindingId: string;
    actionLimits: readonly CompanyAction[];
    platformMcp: boolean;
  }>
> {
  log.debug(
    {
      runId: owner.runId,
      companyId: owner.companyId,
      agentId: actor.agentId,
      packageInstallId: actor.packageInstallId,
      definitionSha256: actor.definitionSha256,
    },
    "checking current company Flow professional binding",
  );
  if (owner.snapshot.schemaVersion !== 2)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A company Flow professional requires a v2 graph execution",
    );
  const row = (
    await tx.execute(sql`
    SELECT binding.id,configuration.snapshot FROM company_specialist_bindings binding
    JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
    JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    WHERE binding.company_id=${owner.companyId} AND binding.agent_id=${actor.agentId} AND binding.enabled AND binding.detached_at IS NULL
      AND package.id=${actor.packageInstallId} AND package.name=${actor.packageName} AND catalog.package_name=package.name
      AND package.resolved_revision=configuration.snapshot->>'packageRevision'
      AND configuration.snapshot->>'definitionSha256'=${actor.definitionSha256}
    FOR SHARE OF binding,configuration,package,catalog
  `)
  ).rows[0];
  const configuration = companySpecialistBindingSnapshotSchema.safeParse(
    row?.snapshot,
  );

  if (
    !row ||
    typeof row.id !== "string" ||
    !configuration.success ||
    configuration.data.agentId !== actor.agentId ||
    configuration.data.packageInstallId !== actor.packageInstallId ||
    configuration.data.packageName !== actor.packageName ||
    !configuration.data.enabled ||
    configuration.data.detachedAt !== null
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "The executing company Flow role's exact reviewed binding and trusted provider are unavailable",
    );
  assertCompanySessionDefinition(configuration.data.definition);
  if (configuration.data.definition.kind === "operational")
    throw new MaisterError(
      "CONFIG",
      "Operational agents cannot be substituted for company Flow personas",
    );

  log.debug(
    { runId: owner.runId, bindingId: row.id, agentId: actor.agentId },
    "company Flow professional binding authorized",
  );

  return {
    bindingId: row.id,
    platformMcp: configuration.data.definition.platformMcp,
    actionLimits: owner.actionLimits.filter((action) =>
      configuration.data.grantActions.includes(action),
    ),
  };
}

export type CompanyFlowNodeKnowledgeOwner = CompanyRunCredentialOwner &
  Readonly<{ platformMcp: boolean }>;

/** Resolve only the server-attested professional of this exact current Flow node. */
export async function requireCompanyFlowNodeKnowledgeOwner(
  tx: SqlTransaction,
  owner: CompanyRunCredentialOwner,
  nodeAttemptId: string,
): Promise<CompanyFlowNodeKnowledgeOwner> {
  log.debug(
    { runId: owner.runId, nodeAttemptId, companyId: owner.companyId },
    "checking current company Flow node authority",
  );
  if (owner.snapshot.schemaVersion !== 2)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Company node authority requires an exact graph execution",
    );
  const node = (
    await tx.execute(sql`
    SELECT node.knowledge_actor FROM runs execution JOIN node_attempts node ON node.run_id=execution.id
    WHERE execution.id=${owner.runId} AND node.id=${nodeAttemptId}
      AND ${currentKnowledgeNodeAttemptPolicy("node", sql`execution.id`, sql`execution.current_step_id`)}
      AND node.node_type IN ('ai_coding','orchestrator')
    FOR SHARE OF execution,node
  `)
  ).rows[0];
  const actor = nativeKnowledgeActorSchema.safeParse(node?.knowledge_actor);

  if (!actor.success)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The company Flow node has no current server-attested professional identity",
    );
  const professional = await requireCompanyFlowProfessionalRole(
    tx,
    owner,
    actor.data,
  );

  log.debug(
    {
      runId: owner.runId,
      nodeAttemptId,
      agentId: actor.data.agentId,
      bindingId: professional.bindingId,
      actionCount: professional.actionLimits.length,
    },
    "company Flow node authority resolved",
  );

  return {
    ...owner,
    platformMcp: professional.platformMcp,
    agentId: actor.data.agentId,
    professionalRole: actor.data,
    bindingId: professional.bindingId,
    actionLimits: professional.actionLimits,
  };
}
