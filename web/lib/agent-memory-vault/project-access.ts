import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";
import type { TokenActor } from "@/lib/tokens/verify";
import type { PrepareVaultAccess, VaultAccess, VaultRevision } from "./store";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { requireVaultActive } from "./cutover";
import { boundFlowVaultPersona } from "./node-attempt";
import { unavailableMemory } from "./store";
import { executionVaultWriteAdmission } from "./write-admission";

import { prepareNativeVaultSources } from "@/lib/agents/native-memory-write";
import { projectRolesForActions } from "@/lib/authz";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { lockCurrentNativeKnowledgeToken } from "@/lib/brain/knowledge-token-lock";
import {
  agentMemoryInjections,
  agentMemoryVaults,
  agentProjectLinks,
  projects,
  projectMembers,
  runs,
  users,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { tokenHasScope } from "@/lib/tokens/scopes";
import { parseBoundRunId } from "@/lib/tokens/verify";

type VaultProjectAction = Extract<
  ProjectAction,
  "readRepoFiles" | "editSettings"
>;

async function requireEnabledAttachment(
  db: Db,
  projectId: string,
  agentId: string,
): Promise<"auto" | "review"> {
  const [attachment] = await db
    .select({
      memoryEnabled: agentProjectLinks.memoryEnabled,
      enabled: agentProjectLinks.enabled,
      policy: agentProjectLinks.memoryWritePolicy,
    })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.projectId, projectId),
        eq(agentProjectLinks.agentId, agentId),
      ),
    )
    .for("share");

  if (!attachment) throw unavailableMemory();
  if (!attachment.enabled || !attachment.memoryEnabled)
    throw new MaisterError(
      "PRECONDITION",
      "Memory is disabled for this agent",
      {
        details: { reason: "agent_memory_disabled" },
      },
    );

  return attachment.policy;
}

export async function ensureProjectVault(
  db: Db,
  projectId: string,
  agentId: string,
): Promise<string> {
  const existing = () =>
    db
      .select({ id: agentMemoryVaults.id })
      .from(agentMemoryVaults)
      .where(
        and(
          eq(agentMemoryVaults.projectId, projectId),
          eq(agentMemoryVaults.agentId, agentId),
        ),
      );
  const [vault] = await existing();

  if (vault) return vault.id;
  const [created] = await db
    .insert(agentMemoryVaults)
    .values({ projectId, agentId })
    .onConflictDoNothing()
    .returning({ id: agentMemoryVaults.id });

  if (created) return created.id;
  const [concurrent] = await existing();

  if (!concurrent)
    throw new MaisterError("CRASH", "Cannot resolve the project vault");

  return concurrent.id;
}

function withinProject(revision: VaultRevision, projectId: string): boolean {
  return revision.sourceProjectIds.every((sourceId) => sourceId === projectId);
}

function humanReadRestrictions(
  revision: VaultRevision,
): KnowledgeAccessRestriction[] {
  return revision.sourceRestrictions.map((source) =>
    source.kind === "legacy_project_private"
      ? { kind: "project_context", projectId: source.projectId }
      : source,
  );
}

type HumanProjectVaultInput = Readonly<{
  userId: string;
  slug: string;
  agentId: string;
  action: VaultProjectAction;
}>;

async function authorizeHumanProjectVault(db: Db, input: HumanProjectVaultInput) {
    await requireVaultActive(db);
    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(
        and(
          eq(users.id, input.userId),
          eq(users.accountStatus, "active"),
          eq(users.mustChangePassword, false),
        ),
      )
      .for("share");

    if (!user) throw new MaisterError("UNAUTHORIZED", "Current user required");
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, input.slug), isNull(projects.archivedAt)))
      .for("share");

    if (!project) throw unavailableMemory();
    if (user.role !== "admin") {
      const [membership] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, project.id),
            eq(projectMembers.userId, input.userId),
            inArray(
              projectMembers.role,
              projectRolesForActions(["readRepoFiles", input.action]),
            ),
          ),
        )
        .for("share");

      if (!membership)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Current project rights do not permit this vault operation",
        );
    }
  return project;
}

function humanProjectVaultAccess(userId: string, projectId: string, vaultId: string): VaultAccess {
    return {
      vaultId,
      principalKey: `user:${userId}`,
      actor: { kind: "human", userId: userId },
      sourceProjectIds: [projectId],
      sourceRestrictions: [],
      writeAdmission: "apply",
      async canRead(tx, revision) {
        if (!withinProject(revision, projectId)) return false;
        try {
          await authorizeSourceRestrictions(
            tx,
            { kind: "user", userId: userId },
            humanReadRestrictions(revision),
          );

          return true;
        } catch (error) {
          if (isMaisterError(error) && error.code === "PRECONDITION")
            return false;
          throw error;
        }
      },
      capture: async () => {},
    };
}

export function prepareHumanProjectVault(input: HumanProjectVaultInput): PrepareVaultAccess {
  return async (db) => {
    const project = await authorizeHumanProjectVault(db, input);
    await requireEnabledAttachment(db, project.id, input.agentId);
    const vaultId = await ensureProjectVault(db, project.id, input.agentId);

    return humanProjectVaultAccess(input.userId, project.id, vaultId);
  };
}

export async function authorizeRetainedProjectVaultReview(db: Db, input: Omit<HumanProjectVaultInput, "action">, vaultId: string) {
  const project = await authorizeHumanProjectVault(db, { ...input, action: "editSettings" });
  const [attachment] = await db.select({ enabled: agentProjectLinks.enabled, memoryEnabled: agentProjectLinks.memoryEnabled })
    .from(agentProjectLinks).where(and(eq(agentProjectLinks.projectId, project.id), eq(agentProjectLinks.agentId, input.agentId))).for("share");
  if (!attachment) throw unavailableMemory();

  return { reviewer: humanProjectVaultAccess(input.userId, project.id, vaultId), enabled: attachment.enabled && attachment.memoryEnabled };
}

export function prepareProjectExecutionVault(
  actor: TokenActor,
  projectId: string,
  action:
    | "agent_memory:read"
    | "agent_memory:write"
    | "agent_memory:propose"
    | "index:compat:read",
): PrepareVaultAccess {
  return async (db) => {
    await requireVaultActive(db);
    if (
      (actor.tokenKind !== "agent" && actor.tokenKind !== "project") ||
      !actor.boundRunId ||
      actor.projectId !== projectId ||
      actor.companyId !== undefined
    )
      throw unavailableMemory();
    const token = await lockCurrentNativeKnowledgeToken(db, actor.tokenId);
    const runId = token.bound_run_id ?? parseBoundRunId(token.name);
    const scope =
      action === "index:compat:read" ? "agent_memory:write" : action;

    if (
      token.company_id !== null ||
      token.token_kind !== actor.tokenKind ||
      token.project_id !== projectId ||
      token.agent_id !== actor.agentId ||
      runId !== actor.boundRunId ||
      !tokenHasScope(token.scopes, scope)
    )
      throw unavailableMemory();
    const nodeAttemptId = token.knowledge_node_attempt_id ?? null;
    const agentId =
      token.token_kind === "agent"
        ? await currentStandalonePersona(db, runId, projectId, token.agent_id)
        : nodeAttemptId !== null && token.origin_kind === "orchestrator_run"
          ? await boundFlowVaultPersona(db, runId, nodeAttemptId, projectId)
          : null;

    if (
      agentId === null ||
      (token.token_kind === "agent" && nodeAttemptId !== null)
    )
      throw unavailableMemory();
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
      .for("share");

    if (!project) throw unavailableMemory();
    const currentPolicy = await requireEnabledAttachment(
      db,
      projectId,
      agentId,
    );
    const vaultId = await ensureProjectVault(db, projectId, agentId);
    const native = await prepareNativeVaultSources(db, {
      tokenId: token.id,
      runId,
      projectId,
      agentId,
      vaultId,
    });
    let writeAdmission: Awaited<
      ReturnType<typeof executionVaultWriteAdmission>
    > = "apply";
    if (action === "agent_memory:write") {
      const [frozen] = await db
        .select({ id: agentMemoryInjections.id })
        .from(agentMemoryInjections)
        .where(
          and(
            eq(agentMemoryInjections.runId, runId),
            eq(agentMemoryInjections.vaultId, vaultId),
            eq(agentMemoryInjections.requiresReviewAtLaunch, true),
            nodeAttemptId === null
              ? isNull(agentMemoryInjections.nodeAttemptId)
              : eq(agentMemoryInjections.nodeAttemptId, nodeAttemptId),
          ),
        )
        .limit(1);

      writeAdmission =
        currentPolicy === "review" || frozen
          ? "review_required"
          : await executionVaultWriteAdmission(db, runId);
    }

    if (action === "agent_memory:write") native.allowWrite();
    const sessionKey = nodeAttemptId ?? runId;

    return {
      vaultId,
      principalKey: `agent:${runId}:${sessionKey}`,
      actor: {
        kind: "agent_session",
        agentId,
        runId,
        sessionKey,
        nodeAttemptId,
      },
      sourceProjectIds: [projectId],
      sourceRestrictions: native.restrictions,
      writeAdmission,
      canRead: (tx, revision) =>
        canReadExecutionNote(tx, projectId, token.id, revision),
      capture: native.capture,
    };
  };
}

async function currentStandalonePersona(
  db: Db,
  runId: string,
  projectId: string,
  agentId: string | null,
): Promise<string | null> {
  if (agentId === null) return null;
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        eq(runs.runKind, "agent"),
        eq(runs.agentId, agentId),
        inArray(runs.status, [
          "Pending",
          "Running",
          "NeedsInput",
          "NeedsInputIdle",
          "WaitingOnChildren",
          "Review",
        ]),
      ),
    )
    .for("no key update");

  return run ? agentId : null;
}

async function canReadExecutionNote(
  tx: Db,
  projectId: string,
  tokenId: string,
  revision: VaultRevision,
): Promise<boolean> {
  if (!withinProject(revision, projectId)) return false;
  // Non-native credentials have no current source transport for nested
  // restrictions. Private local context and historical private imports
  // can still be inspected under the exact attachment above.
  const refs = humanReadRestrictions(revision);

  if (
    refs.every(
      (ref) => ref.kind === "project_context" && ref.projectId === projectId,
    )
  )
    return true;
  try {
    await authorizeSourceRestrictions(tx, { kind: "token", tokenId }, refs);

    return true;
  } catch (error) {
    if (
      isMaisterError(error) &&
      ["PRECONDITION", "UNAUTHORIZED"].includes(error.code)
    )
      return false;
    throw error;
  }
}
