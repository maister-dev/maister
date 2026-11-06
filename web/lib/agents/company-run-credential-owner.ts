import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyAction } from "@/lib/company/types";
import type { CompanyAgentExecutionSnapshot } from "./company-agent-execution-types";

import { sql } from "drizzle-orm";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";
import { bindingActionSubsetSchema } from "./company-binding-types";

import { MaisterError } from "@/lib/errors";

export type CompanyRunCredentialOwner = Readonly<{
  companyId: string;
  runId: string;
  agentId: string;
  userId: string;
  actionLimits: readonly CompanyAction[];
  snapshot: CompanyAgentExecutionSnapshot;
}>;

/** Credential verification is current read authority; each mutation still needs its own current domain action. */
export async function requireCompanyRunCredentialOwner(
  tx: SqlTransaction,
  runId: string,
): Promise<CompanyRunCredentialOwner> {
  const row = (
    await tx.execute(sql`
    SELECT execution.company_id,execution.source_agent_id,execution.company_execution_snapshot,configuration.snapshot->'grantActions' AS action_limits
    FROM runs execution
    JOIN specialist_run_links link ON link.run_id=execution.id
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id AND assignment.project_id IS NULL
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision
    JOIN company_specialist_bindings binding ON binding.id=assignment.specialist_binding_id AND binding.company_id=execution.company_id AND binding.enabled AND binding.detached_at IS NULL
    JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
    JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    JOIN users principal ON principal.id=execution.company_execution_snapshot->'authority'->'actor'->>'id' AND principal.account_status='active' AND NOT principal.must_change_password
    JOIN company_grants read_grant ON read_grant.company_id=execution.company_id AND read_grant.principal_type='user' AND read_grant.principal_id=principal.id AND read_grant.action='assignments:read' AND read_grant.revoked_at IS NULL
    WHERE execution.id=${runId} AND execution.company_id IS NOT NULL AND execution.project_id IS NULL AND execution.run_kind='agent'
      AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking')
      AND assignment.status NOT IN ('completed','failed','cancelled')
      AND assignment.id=execution.company_execution_snapshot->'assignment'->>'id'
      AND input.revision::numeric=(execution.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND input.digest=execution.company_execution_snapshot->'assignment'->>'inputSha256'
      AND binding.id=execution.company_execution_snapshot->'specialistBinding'->>'id'
      AND binding.revision::numeric=(execution.company_execution_snapshot->'specialistBinding'->>'revision')::numeric
      AND configuration.snapshot_digest=execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'
      AND binding.agent_id=execution.source_agent_id
      AND package.resolved_revision=configuration.snapshot->>'packageRevision'
    FOR SHARE OF execution,assignment,binding,package,catalog,principal,read_grant
  `)
  ).rows[0];
  const snapshot = companyAgentExecutionSnapshotSchema.safeParse(
    row?.company_execution_snapshot,
  );
  const actions = bindingActionSubsetSchema.safeParse(row?.action_limits);

  if (
    !row ||
    !snapshot.success ||
    !actions.success ||
    row.company_id !== snapshot.data.owner.companyId ||
    typeof row.source_agent_id !== "string"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current company agent runtime authority is unavailable",
      { details: { reason: "company_agent_runtime_unavailable" } },
    );

  return {
    companyId: snapshot.data.owner.companyId,
    runId,
    agentId: row.source_agent_id,
    userId: snapshot.data.authority.actor.id,
    actionLimits: actions.data,
    snapshot: snapshot.data,
  };
}
