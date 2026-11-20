import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  InstallationAgentGrant,
  InstallationAgentScope,
} from "./installation-access-types";

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { installationAgentGrantSchema } from "./installation-access-types";
import {
  assertCurrentInstallationSources,
  installationRunSourceCapture,
} from "./installation-source-capture";

import { projectRolesForActions } from "@/lib/authz";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { lockCurrentNativeKnowledgeToken } from "@/lib/brain/knowledge-token-lock";
import { MaisterError } from "@/lib/errors";

const principal = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("manual"),
    userId: z.string().min(1).max(192),
  }),
  z.strictObject({
    kind: z.literal("unattended"),
    trigger: z.enum(["cron", "domain_event"]),
  }),
]);
const retained = z.strictObject({
  id: z.string(),
  agent_id: z.string(),
  company_id: z.string(),
  binding_id: z.string(),
  binding_revision: z.number().int().positive(),
  grant: installationAgentGrantSchema,
  captured_grant: installationAgentGrantSchema,
  principal,
  trigger_source: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
});

export type InstallationRunAuthority = Readonly<{
  runId: string;
  agentId: string;
  companyId: string;
  bindingId: string;
  bindingRevision: number;
  scopes: readonly InstallationAgentScope[];
  memoryEnabled: boolean;
  principal: z.infer<typeof principal>;
}>;

function denied() {
  return new MaisterError(
    "UNAUTHORIZED",
    "A current installation agent grant is required",
  );
}

export async function retainInstallationRunAuthority(
  tx: SqlTransaction,
  input: Readonly<{
    runId: string;
    bindingId: string;
    revision: number;
    snapshotDigest: string;
    grant: InstallationAgentGrant;
    principal: z.infer<typeof principal>;
  }>,
) {
  await tx.execute(sql`INSERT INTO agent_installation_run_authorities(run_id,binding_id,binding_revision,binding_digest,grant_snapshot,principal)
    VALUES(${input.runId},${input.bindingId},${input.revision},${input.snapshotDigest},${JSON.stringify(input.grant)}::jsonb,
      ${JSON.stringify(input.principal)}::jsonb)`);
}

export async function requireInstallationRunAuthority(
  tx: SqlTransaction,
  runId: string,
): Promise<InstallationRunAuthority | null> {
  const observed = (
    await tx.execute(
      sql`SELECT 1 FROM agent_installation_run_authorities WHERE run_id=${runId}`,
    )
  ).rows[0];

  if (!observed) return null;
  const result = await tx.execute(sql`
    SELECT r.id,r.agent_id,r.company_id,r.trigger_source,r.created_by_user_id,b.id AS binding_id,b.revision AS binding_revision,
      v.snapshot->'installationGrant' AS grant,a.grant_snapshot AS captured_grant,a.principal
    FROM agent_installation_run_authorities a
    JOIN runs r ON r.id=a.run_id
    JOIN company_specialist_bindings b ON b.id=a.binding_id AND b.revision=a.binding_revision
      AND (b.company_id,b.agent_id)=(r.company_id,r.agent_id)
    JOIN company_specialist_binding_revisions v ON (v.binding_id,v.revision,v.snapshot_digest)=(b.id,a.binding_revision,a.binding_digest)
    JOIN agents catalog ON catalog.id=b.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    JOIN package_installs pin ON pin.id=b.package_install_id AND pin.package_status='Installed'
      AND pin.trust_status IN ('trusted','trusted_by_policy') AND pin.resolved_revision=v.snapshot->>'packageRevision'
    WHERE r.id=${runId} AND r.project_id IS NULL AND r.task_id IS NULL AND r.run_kind='agent'
       AND r.agent_workspace='none' AND r.parent_run_id IS NULL AND b.enabled AND b.detached_at IS NULL
       AND r.company_execution_snapshot->'specialistBinding'->>'id'=a.binding_id
       AND r.company_execution_snapshot->'specialistBinding'->>'revision'=a.binding_revision::text
       AND r.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'=a.binding_digest
       AND a.grant_snapshot=v.snapshot->'installationGrant'
       AND ((r.trigger_source='manual' AND r.agent_schedule_id IS NULL AND r.trigger_event_id IS NULL)
         OR (r.trigger_source IN ('cron','domain_event') AND EXISTS (
           SELECT 1 FROM agent_trigger_attempts t WHERE t.reserved_run_id=coalesce(r.retry_of_run_id,r.id)
             AND t.schedule_id=r.agent_schedule_id AND t.company_id=r.company_id
             AND t.trigger_source=r.trigger_source AND t.trigger_event_id IS NOT DISTINCT FROM r.trigger_event_id
             AND t.binding_snapshot->'specialistBinding'->>'id'=a.binding_id
             AND t.binding_snapshot->'specialistBinding'->>'revision'=a.binding_revision::text
             AND t.binding_snapshot->'specialistBinding'->>'snapshotSha256'=a.binding_digest FOR SHARE OF t)))
       AND r.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review')
    FOR SHARE OF b,v,catalog,pin
  `);
  const current = retained.safeParse(result.rows[0]);

  if (!current.success) throw denied();
  const { grant, captured_grant: captured, principal: owner } = current.data;
  const scopes = captured.scopes.filter((scope) =>
    grant.scopes.includes(scope),
  );

  if (owner.kind === "manual") {
    if (
      current.data.created_by_user_id !== owner.userId ||
      current.data.trigger_source !== "manual"
    )
      throw denied();
    const user =
      await tx.execute(sql`SELECT 1 FROM users WHERE id=${owner.userId} AND account_status='active'
      AND NOT must_change_password FOR SHARE`);

    if (!user.rows.length) throw denied();
    const assignmentGrants = await tx.execute(sql`
      SELECT action FROM company_grants WHERE company_id=${current.data.company_id}
        AND principal_type='user' AND principal_id=${owner.userId} AND revoked_at IS NULL
        AND action IN ('assignments:read','assignments:update') FOR SHARE
    `);
    const actions = new Set(assignmentGrants.rows.map(({ action }) => action));

    if (!actions.has("assignments:read") || !actions.has("assignments:update"))
      throw denied();
  } else if (owner.trigger !== current.data.trigger_source) throw denied();

  return {
    runId,
    agentId: current.data.agent_id,
    companyId: current.data.company_id,
    bindingId: current.data.binding_id,
    bindingRevision: current.data.binding_revision,
    scopes,
    memoryEnabled: captured.memoryEnabled && grant.memoryEnabled,
    principal: owner,
  };
}

export async function requireInstallationCredential(
  tx: SqlTransaction,
  tokenId: string,
  scope: InstallationAgentScope,
) {
  const token = await lockCurrentNativeKnowledgeToken(tx, tokenId);

  if (
    token.project_id !== null ||
    !token.company_id ||
    !token.company_run_id ||
    token.token_kind !== "agent" ||
    token.installation_run_id !== token.company_run_id ||
    token.knowledge_node_attempt_id !== null ||
    !Array.isArray(token.scopes) ||
    !token.scopes.includes(scope)
  )
    throw denied();
  const context = await requireInstallationRunAuthority(
    tx,
    token.company_run_id,
  );

  if (
    !context ||
    context.companyId !== token.company_id ||
    context.agentId !== token.agent_id ||
    !context.scopes.includes(scope)
  )
    throw denied();

  // The native credential lock already serializes disclosure on this Run.
  // Recheck its prior inputs before any adapter can read a new resource.
  await assertCurrentInstallationSources(tx, context);
  const capture = await installationRunSourceCapture(tx, context.runId);

  await authorizeSourceRestrictions(
    tx,
    { kind: "execution", runId: context.runId, nodeAttemptId: null },
    capture.restrictions,
  );

  return context;
}

export function installationProjectAccess(
  context: InstallationRunAuthority,
  projectId: SQL,
  action: ProjectAction,
): SQL {
  if (context.principal.kind === "unattended") return sql`true`;
  const userId = context.principal.userId;
  const roles = sql.join(
    projectRolesForActions([action]).map((role) => sql`${role}`),
    sql`, `,
  );

  return sql`EXISTS (SELECT 1 FROM users u WHERE u.id=${userId} AND u.account_status='active'
    AND NOT u.must_change_password AND (u.role='admin' OR EXISTS (SELECT 1 FROM project_members m
      WHERE m.project_id=${projectId} AND m.user_id=u.id AND m.role IN (${roles}) FOR SHARE)) FOR SHARE)`;
}
