import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { Owner } from "@/lib/company/types";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeAttribution } from "./record-types";
import type { SessionUser } from "@/lib/authz";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { parseBoundRunId } from "@/lib/tokens/verify";

export type KnowledgeTransaction = SqlTransaction;
export type KnowledgeDatabase = SqlDatabase;
export type KnowledgeAuthorityActor = KnowledgeAttribution &
  Readonly<{ kind: "user" | "agent"; id: string }>;
export type KnowledgeAuthority = Readonly<{
  actor: KnowledgeAuthorityActor;
  policy: Readonly<{
    version: 1;
    authorityId: string;
    authorityRevision: number;
    confirmationClasses: readonly string[];
  }>;
}>;
export type KnowledgePrincipalIdentity =
  | Readonly<{
      kind: "user";
      actor: KnowledgeAuthorityActor;
      user: SessionUser;
      boundProjectId: string | null;
    }>
  | Readonly<{
      kind: "agent";
      actor: KnowledgeAuthorityActor;
      projectId: string;
      bindingId: string;
      canReadBrain: boolean;
      canWriteBrain: boolean;
    }>;

export function knowledgeOwner(row: Readonly<Record<string, unknown>>): Owner {
  if (typeof row.company_id === "string" && row.project_id === null)
    return { kind: "company", companyId: row.company_id };
  if (typeof row.project_id === "string" && row.company_id === null)
    return { kind: "project", projectId: row.project_id };
  throw new MaisterError("CONFIG", "Knowledge ownership is invalid");
}

async function currentKnowledgeUser(
  tx: KnowledgeTransaction,
  userId: string,
): Promise<Extract<KnowledgePrincipalIdentity, { kind: "user" }>> {
  const user = (
    await tx.execute(
      sql`SELECT id,role,account_status AS "accountStatus",must_change_password AS "mustChangePassword" FROM users WHERE id=${userId} FOR SHARE`,
    )
  ).rows[0] as unknown as SessionUser | undefined;

  if (!user)
    throw new MaisterError(
      "UNAUTHENTICATED",
      "Current knowledge principal is unavailable",
    );
  if (user.accountStatus !== "active")
    throw new MaisterError(
      "ACCOUNT_INACTIVE",
      "Current knowledge principal is inactive",
    );
  if (user.mustChangePassword)
    throw new MaisterError(
      "PASSWORD_CHANGE_REQUIRED",
      "Change the password before using knowledge",
    );

  return {
    kind: "user",
    user,
    boundProjectId: null,
    actor: { kind: "user", id: user.id, runId: null, attemptId: null },
  };
}

/** Identity, token scope and immutable package binding come only from current server state. */
export async function resolveKnowledgePrincipal(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  action: KnowledgeAction,
): Promise<KnowledgePrincipalIdentity> {
  if (principal.kind === "user")
    return currentKnowledgeUser(tx, principal.userId);
  const token = (
    await tx.execute(
      sql`SELECT id,name,token_kind,owner_user_id,project_id,agent_id,scopes FROM project_tokens WHERE id=${principal.tokenId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`,
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
  if (token.token_kind === "user" && typeof token.owner_user_id === "string") {
    const identity = await currentKnowledgeUser(tx, token.owner_user_id);

    return {
      ...identity,
      boundProjectId:
        typeof token.project_id === "string" ? token.project_id : null,
    };
  }
  if (
    token.token_kind !== "agent" &&
    !(
      token.token_kind === "project" &&
      String(token.name).startsWith("orchestrator-run:")
    )
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An active bound specialist identity is required",
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
    typeof run.project_id !== "string" ||
    token.project_id !== run.project_id
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An active bound specialist identity is required",
    );
  const activity = run.agent_activity_snapshot as Readonly<{
    version?: number;
    agentId?: string;
    packageInstallId?: string;
    packageName?: string;
  }> | null;

  if (typeof activity?.packageInstallId !== "string")
    throw new MaisterError(
      "PRECONDITION",
      "An immutable agent package identity is required for native knowledge",
    );
  if (
    run.source_agent_id !== agentId ||
    activity.version !== 1 ||
    activity.agentId !== agentId ||
    typeof activity.packageName !== "string"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "The native knowledge token does not match its immutable run identity",
    );
  const binding = (
    await tx.execute(sql`
    SELECT l.id,l.can_read_brain,l.can_write_brain FROM agent_project_links l
    JOIN agents a ON a.id=l.agent_id
    JOIN project_package_attachments pa ON pa.project_id=l.project_id AND pa.package_name=a.package_name
    JOIN package_installs current_pin ON current_pin.id=pa.package_install_id
    JOIN package_installs frozen_pin ON frozen_pin.id=${activity.packageInstallId} AND frozen_pin.name=a.package_name
    WHERE l.agent_id=${agentId} AND a.package_name=${activity.packageName} AND l.project_id=${run.project_id} AND l.enabled AND a.enabled AND a.quarantined_at IS NULL
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

  return {
    kind: "agent",
    actor: { kind: "agent", id: agentId, runId, attemptId: null },
    projectId: run.project_id,
    bindingId: String(binding.id),
    canReadBrain: binding.can_read_brain === true,
    canWriteBrain: binding.can_write_brain === true,
  };
}

/** Owner policies remain distinct from identity and are checked inside the domain transaction. */
export async function authorizeKnowledge(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  owner: Owner,
  action: KnowledgeAction,
): Promise<KnowledgeAuthority> {
  const identity = await resolveKnowledgePrincipal(tx, principal, action);

  if (
    identity.kind === "user" &&
    identity.boundProjectId !== null &&
    (owner.kind !== "project" || owner.projectId !== identity.boundProjectId)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Knowledge owner is outside this credential's project boundary",
    );

  if (owner.kind === "company")
    return authorizeCompanyPrincipal(
      tx,
      identity.actor,
      owner.companyId,
      action,
    );
  const project = (
    await tx.execute(
      sql`SELECT id,brain_enabled FROM projects WHERE id=${owner.projectId} FOR SHARE`,
    )
  ).rows[0];

  if (!project || project.brain_enabled !== true)
    throw new MaisterError("UNAUTHORIZED", "Project knowledge is unavailable");
  if (identity.kind === "agent") {
    const allowed =
      action === "knowledge:read"
        ? identity.canReadBrain
        : action === "knowledge:propose"
          ? identity.canWriteBrain
          : false;

    if (owner.projectId !== identity.projectId || !allowed)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The agent lacks project knowledge authority",
      );

    return {
      actor: identity.actor,
      policy: {
        version: 1,
        authorityId: identity.bindingId,
        authorityRevision: 1,
        confirmationClasses: [],
      },
    };
  }
  const projectAction =
    action === "knowledge:read"
      ? "readBrain"
      : action === "knowledge:propose"
        ? "writeBrain"
        : "editSettings";
  const roles = projectRolesForActions([projectAction]);
  const membership = (
    await tx.execute(
      sql`SELECT id,role FROM project_members WHERE project_id=${owner.projectId} AND user_id=${identity.user.id} FOR SHARE`,
    )
  ).rows[0] as
    { id: string; role: "viewer" | "member" | "admin" | "owner" } | undefined;

  if (
    identity.user.role !== "admin" &&
    (!membership || !roles.includes(membership.role))
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project knowledge authority is required",
    );

  return {
    actor: identity.actor,
    policy: {
      version: 1,
      authorityId: membership?.id ?? `global-admin:${identity.user.id}`,
      authorityRevision: 1,
      confirmationClasses: [],
    },
  };
}

async function authorizeCompanyPrincipal(
  tx: KnowledgeTransaction,
  actor: KnowledgeAuthorityActor,
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
