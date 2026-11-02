import "server-only";

import type { SQL } from "drizzle-orm";
import type { Owner } from "@/lib/company/types";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeAttribution } from "./record-types";
import type { SessionUser } from "@/lib/authz";

import { sql } from "drizzle-orm";

import { PROJECT_ACTION_MIN, projectRolesForActions } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { parseBoundRunId } from "@/lib/tokens/verify";

export type KnowledgeTransaction = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};
export type KnowledgeDatabase = KnowledgeTransaction & {
  transaction<T>(action: (tx: KnowledgeTransaction) => Promise<T>): Promise<T>;
};
export type KnowledgeAuthority = Readonly<{
  actor: KnowledgeAttribution;
  policy: Readonly<{
    version: 1;
    authorityId: string;
    authorityRevision: number;
    confirmationClasses: readonly string[];
  }>;
}>;

/** Owner policies are evaluated under the caller's transaction, never from model claims. */
export async function authorizeKnowledge(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  owner: Owner,
  action: KnowledgeAction,
): Promise<KnowledgeAuthority> {
  if (principal.kind === "token")
    return authorizeKnowledgeToken(tx, principal.tokenId, owner, action);
  const row = (
    await tx.execute(
      sql`SELECT id,role,account_status AS "accountStatus",must_change_password AS "mustChangePassword" FROM users WHERE id=${principal.userId} FOR SHARE`,
    )
  ).rows[0] as unknown as SessionUser | undefined;

  if (!row)
    throw new MaisterError(
      "UNAUTHENTICATED",
      "Current knowledge principal is unavailable",
    );
  if (row.accountStatus !== "active")
    throw new MaisterError(
      "ACCOUNT_INACTIVE",
      "Current knowledge principal is inactive",
    );
  if (row.mustChangePassword)
    throw new MaisterError(
      "PASSWORD_CHANGE_REQUIRED",
      "Change the password before using knowledge",
    );
  const actor: KnowledgeAttribution = {
    kind: "user",
    id: row.id,
    runId: null,
    attemptId: null,
  };

  if (owner.kind === "company")
    return authorizeCompanyPrincipal(tx, actor, owner.companyId, action);
  const project = (
    await tx.execute(
      sql`SELECT id,brain_enabled FROM projects WHERE id=${owner.projectId} FOR SHARE`,
    )
  ).rows[0];

  if (!project || project.brain_enabled !== true)
    throw new MaisterError("UNAUTHORIZED", "Project knowledge is unavailable");
  const projectAction =
    action === "knowledge:read"
      ? "readBrain"
      : action === "knowledge:propose"
        ? "writeBrain"
        : "editSettings";
  const roles = projectRolesForActions([projectAction]);
  const membership = (
    await tx.execute(
      sql`SELECT id,role FROM project_members WHERE project_id=${owner.projectId} AND user_id=${row.id} FOR SHARE`,
    )
  ).rows[0];

  if (
    row.role !== "admin" &&
    !roles.includes(
      membership?.role as (typeof PROJECT_ACTION_MIN)[typeof projectAction],
    )
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project knowledge authority is required",
    );

  return {
    actor,
    policy: {
      version: 1,
      authorityId: String(membership?.id ?? `global-admin:${row.id}`),
      authorityRevision: 1,
      confirmationClasses: [],
    },
  };
}

async function authorizeCompanyPrincipal(
  tx: KnowledgeTransaction,
  actor: KnowledgeAttribution,
  companyId: string,
  action: KnowledgeAction,
): Promise<KnowledgeAuthority> {
  const grant = (
    await tx.execute(
      sql`SELECT id,revision,confirmation_classes FROM company_grants WHERE company_id=${companyId} AND principal_type=${actor.kind} AND principal_id=${actor.id} AND action=${action} AND revoked_at IS NULL FOR SHARE`,
    )
  ).rows[0];

  if (!grant)
    throw new MaisterError(
      "UNAUTHORIZED",
      "An explicit current company grant is required",
      { details: { reason: "company_grant_required" } },
    );

  return {
    actor,
    policy: {
      version: 1,
      authorityId: String(grant.id),
      authorityRevision: Number(grant.revision),
      confirmationClasses: grant.confirmation_classes as string[],
    },
  };
}

async function authorizeKnowledgeToken(
  tx: KnowledgeTransaction,
  tokenId: string,
  owner: Owner,
  action: KnowledgeAction,
): Promise<KnowledgeAuthority> {
  const token = (
    await tx.execute(
      sql`SELECT id,name,token_kind,owner_user_id,project_id,agent_id,scopes FROM project_tokens WHERE id=${tokenId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`,
    )
  ).rows[0];

  if (
    !token ||
    !Array.isArray(token.scopes) ||
    (!token.scopes.includes("*") && !token.scopes.includes(action))
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current knowledge token scope is required",
    );
  if (token.token_kind === "user" && typeof token.owner_user_id === "string")
    return authorizeKnowledge(
      tx,
      { kind: "user", userId: token.owner_user_id },
      owner,
      action,
    );
  if (token.token_kind === "librarian")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Personal librarian tokens cannot access shared knowledge",
    );
  const runId = parseBoundRunId(String(token.name));
  const run =
    runId === null
      ? undefined
      : (
          await tx.execute(
            sql`SELECT id,project_id,source_agent_id,agent_activity_snapshot FROM runs WHERE id=${runId} AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review') FOR SHARE`,
          )
        ).rows[0];
  const agentId =
    token.token_kind === "agent" ? token.agent_id : run?.source_agent_id;

  if (
    !run ||
    typeof agentId !== "string" ||
    token.project_id !== run.project_id
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An active bound specialist identity is required",
    );
  const activity = run.agent_activity_snapshot as {
    packageInstallId?: string;
  } | null;

  if (typeof activity?.packageInstallId !== "string")
    throw new MaisterError(
      "PRECONDITION",
      "An immutable agent package identity is required for native knowledge",
    );
  const binding = (
    await tx.execute(sql`
    SELECT l.id,l.can_read_brain,l.can_write_brain FROM agent_project_links l
    JOIN agents a ON a.id=l.agent_id
    JOIN project_package_attachments pa ON pa.project_id=l.project_id AND pa.package_name=a.package_name
    JOIN package_installs current_pin ON current_pin.id=pa.package_install_id
    JOIN package_installs frozen_pin ON frozen_pin.id=${activity.packageInstallId} AND frozen_pin.name=a.package_name
    WHERE l.agent_id=${agentId} AND l.project_id=${run.project_id} AND l.enabled AND a.enabled AND a.quarantined_at IS NULL
      AND current_pin.package_status='Installed' AND current_pin.trust_status IN ('trusted','trusted_by_policy')
      AND frozen_pin.package_status='Installed' AND frozen_pin.trust_status IN ('trusted','trusted_by_policy')
    FOR SHARE OF l,a,pa,current_pin,frozen_pin
  `)
  ).rows[0];

  if (!binding)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The active agent knowledge binding is unavailable",
    );
  const actor: KnowledgeAttribution = {
    kind: "agent",
    id: agentId,
    runId,
    attemptId: null,
  };

  if (owner.kind === "company")
    return authorizeCompanyPrincipal(tx, actor, owner.companyId, action);
  const allowed =
    action === "knowledge:read"
      ? binding.can_read_brain
      : action === "knowledge:propose"
        ? binding.can_write_brain
        : false;

  if (owner.projectId !== run.project_id || allowed !== true)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The agent lacks project knowledge authority",
    );

  return {
    actor,
    policy: {
      version: 1,
      authorityId: String(binding.id),
      authorityRevision: 1,
      confirmationClasses: [],
    },
  };
}
