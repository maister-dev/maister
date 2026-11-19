import "server-only";

import type { InstallationRunAuthority } from "@/lib/agents/installation-authority";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyExecutionSnapshot } from "@/lib/agents/company-execution-types";
import type { CompanyAction, Owner } from "@/lib/company/types";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeAttribution } from "./record-types";
import type { SessionUser } from "@/lib/authz";

import { sql } from "drizzle-orm";
import {
  installationProjectAccess,
  requireInstallationCredential,
  requireInstallationRunAuthority,
} from "@/lib/agents/installation-authority";

import { resolveKnowledgeRunIdentity } from "./knowledge-run-identity";
import { lockCurrentNativeKnowledgeToken } from "./knowledge-token-lock";

import { requireCompanyRunCredentialOwner } from "@/lib/agents/company-run-credential-owner";
import { projectRolesForActions } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { parseBoundRunId } from "@/lib/tokens/verify";

export type KnowledgeTransaction = SqlTransaction;
export type KnowledgeDatabase = SqlDatabase;
export type KnowledgeAuthorityActor = KnowledgeAttribution &
  Readonly<{ kind: "user" | "agent"; id: string }>;
type KnowledgeAuthorityPolicyBase = Readonly<{
  authorityId: string;
  authorityRevision: number;
  confirmationClasses: readonly string[];
}>;
export type KnowledgeAuthority = Readonly<{
  actor: KnowledgeAuthorityActor;
  policy: KnowledgeAuthorityPolicyBase &
    (
      | Readonly<{ version: 1 }>
      | Readonly<{
          version: 2;
          initiator: Readonly<{
            actor: KnowledgeAuthorityActor & { kind: "user" };
            authorityId: string;
            authorityRevision: number;
          }>;
          execution: Readonly<{
            runId: string;
            launchSnapshot: CompanyExecutionSnapshot;
          }>;
        }>
    );
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
    }>
  | Readonly<{
      kind: "company_agent";
      actor: KnowledgeAuthorityActor & {
        kind: "agent";
        runId: string;
        attemptId: string | null;
      };
      companyId: string;
      bindingId: string;
      initiatingUser: SessionUser;
      actionLimits: readonly CompanyAction[];
      execution: CompanyExecutionSnapshot;
    }>
  | Readonly<{
      kind: "installation_agent";
      actor: KnowledgeAuthorityActor & {
        kind: "agent";
        runId: string;
        attemptId: null;
      };
      installation: InstallationRunAuthority;
    }>;

function installationKnowledgeIdentity(
  installation: InstallationRunAuthority,
): KnowledgePrincipalIdentity {
  return {
    kind: "installation_agent",
    installation,
    actor: {
      kind: "agent",
      id: installation.agentId,
      runId: installation.runId,
      attemptId: null,
    },
  };
}

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
  if (principal.kind === "execution") {
    if (action !== "knowledge:read")
      throw new MaisterError(
        "UNAUTHORIZED",
        "Execution inspection is read-only and cannot authorize knowledge changes",
      );
    const installation =
      principal.nodeAttemptId === null
        ? await requireInstallationRunAuthority(tx, principal.runId)
        : null;
    if (installation) return installationKnowledgeIdentity(installation);
    const resolved = await resolveKnowledgeRunIdentity(
      tx,
      principal.runId,
      principal.nodeAttemptId,
    );

    if (resolved.runKind === "flow" && principal.nodeAttemptId === null)
      throw new MaisterError(
        "UNAUTHORIZED",
        "A Flow inspector must identify its current node attempt",
      );

    return resolved.identity;
  }

  return resolveNativeTokenPrincipal(tx, principal.tokenId, action);
}

/** Shared current credential binding; the requested domain scope does not grant Brain access. */
export async function resolveNativeTokenPrincipal(
  tx: KnowledgeTransaction,
  tokenId: string,
  action: CompanyAction,
): Promise<KnowledgePrincipalIdentity> {
  const token = await lockCurrentNativeKnowledgeToken(tx, tokenId);
  if (
    token.installation_run_id !== null &&
    token.installation_run_id !== undefined
  ) {
    if (action !== "knowledge:read" && action !== "knowledge:propose")
      throw new MaisterError(
        "UNAUTHORIZED",
        "Installation agents can only read or propose knowledge",
      );

    return installationKnowledgeIdentity(
      await requireInstallationCredential(tx, tokenId, action),
    );
  }

  if (
    !token ||
    !Array.isArray(token.scopes) ||
    (!token.scopes.includes("*") && !token.scopes.includes(action))
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current native token scope is required",
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

  if (runId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A bound specialist credential is required",
    );
  const resolved = await resolveKnowledgeRunIdentity(
    tx,
    runId,
    typeof token.knowledge_node_attempt_id === "string"
      ? token.knowledge_node_attempt_id
      : null,
  );

  if (resolved.identity.kind === "company_agent") {
    const current = await requireCompanyRunCredentialOwner(tx, runId);

    if (
      token.token_kind !== "agent" ||
      token.project_id !== null ||
      token.company_id !== current.companyId ||
      token.company_run_id !== runId ||
      token.agent_id !== resolved.identity.actor.id ||
      token.owner_user_id !== current.userId
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The credential does not match its current company execution and initiating principal",
      );

    return resolved.identity;
  }
  if (
    token.project_id !== resolved.identity.projectId ||
    (token.token_kind === "agent" &&
      token.agent_id !== resolved.identity.actor.id)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "The credential does not match the immutable executing role",
    );

  return resolved.identity;
}

/** Owner policies remain distinct from identity and are checked inside the domain transaction. */
export async function authorizeKnowledge(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  owner: Owner,
  action: KnowledgeAction,
): Promise<KnowledgeAuthority> {
  const identity = await resolveKnowledgePrincipal(tx, principal, action);

  if (identity.kind === "installation_agent") {
    const context = identity.installation;
    if (
      (action !== "knowledge:read" && action !== "knowledge:propose") ||
      !context.scopes.includes(action)
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "Current installation knowledge scope is required",
      );
    if (owner.kind === "company") {
      if (owner.companyId !== context.companyId)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Knowledge owner is unavailable",
        );
      if (context.principal.kind === "manual")
        await authorizeCompanyPrincipal(
          tx,
          {
            kind: "user",
            id: context.principal.userId,
            runId: null,
            attemptId: null,
          },
          owner.companyId,
          action,
        );
    } else {
      const projectAction =
        action === "knowledge:read" ? "readBrain" : "writeBrain";
      const allowed =
        await tx.execute(sql`SELECT id FROM projects p WHERE p.id=${owner.projectId}
        AND p.archived_at IS NULL AND p.brain_enabled AND ${installationProjectAccess(context, sql`p.id`, projectAction)} FOR SHARE`);
      if (!allowed.rows.length)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Knowledge owner is unavailable",
        );
    }

    return {
      actor: identity.actor,
      policy: {
        version: 1,
        authorityId: context.bindingId,
        authorityRevision: context.bindingRevision,
        confirmationClasses: [],
      },
    };
  }

  if (
    identity.kind === "user" &&
    identity.boundProjectId !== null &&
    (owner.kind !== "project" || owner.projectId !== identity.boundProjectId)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Knowledge owner is outside this credential's project boundary",
    );

  if (identity.kind === "company_agent") {
    if (
      owner.kind !== "company" ||
      owner.companyId !== identity.companyId ||
      !["knowledge:read", "knowledge:propose"].includes(action) ||
      !identity.actionLimits.includes(action)
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The company execution lacks authority for this knowledge owner and action",
      );
    const initiatorActor = {
      kind: "user" as const,
      id: identity.initiatingUser.id,
      runId: null,
      attemptId: null,
    };
    const initiator = await authorizeCompanyPrincipal(
      tx,
      initiatorActor,
      owner.companyId,
      action,
    );
    const professional = await authorizeCompanyPrincipal(
      tx,
      identity.actor,
      owner.companyId,
      action,
    );

    return {
      actor: professional.actor,
      policy: {
        ...professional.policy,
        version: 2,
        confirmationClasses: [],
        initiator: {
          actor: initiatorActor,
          authorityId: initiator.policy.authorityId,
          authorityRevision: initiator.policy.authorityRevision,
        },
        execution: {
          runId: identity.actor.runId,
          launchSnapshot: identity.execution,
        },
      },
    };
  }
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
