import "server-only";

import type { InstallationRunAuthority } from "@/lib/agents/installation-authority";
import type { Db } from "@/lib/execution-host/db";
import type { VaultBindingAvailability } from "./availability";
import type { PrepareVaultAccess, VaultRevision } from "./store";

import { and, eq, sql } from "drizzle-orm";

import { installationVaultAvailability } from "./availability";
import { installationLinkSources } from "./installation-link-sources";
import { requireVaultActive } from "./cutover";
import { unavailableMemory } from "./store";

import {
  installationProjectAccess,
  requireInstallationCredential,
} from "@/lib/agents/installation-authority";
import {
  captureInstallationProjects,
  installationRunProjects,
} from "@/lib/agents/installation-source-capture";
import { recordNativeRunSourcesInTransaction } from "@/lib/brain/knowledge-execution-access";
import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { agentMemoryVaults as vaults } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

export { installationVaultAvailability } from "./availability";

export async function ensureInstallationVault(
  tx: Db,
  companyId: string,
  agentId: string,
): Promise<string> {
  const query = () =>
    tx
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(eq(vaults.companyId, companyId), eq(vaults.agentId, agentId)));
  const [existing] = await query();

  if (existing) return existing.id;
  const [created] = await tx
    .insert(vaults)
    .values({ companyId, agentId })
    .onConflictDoNothing()
    .returning({ id: vaults.id });

  if (created) return created.id;
  const [concurrent] = await query();

  if (!concurrent)
    throw new MaisterError("CRASH", "Installation vault owner is unavailable");

  return concurrent.id;
}

export async function seesEveryProject(
  tx: Db,
  context: InstallationRunAuthority,
  ids: readonly string[],
): Promise<boolean> {
  if (!ids.length) return true;
  const allowed =
    await tx.execute(sql`SELECT id FROM projects WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    AND archived_at IS NULL AND ${installationProjectAccess(context, sql`projects.id`, "readBoard")} FOR SHARE`);

  return allowed.rows.length === new Set(ids).size;
}

export function prepareInstallationExecutionVault(
  tokenId: string,
  action: "agent_memory:read" | "agent_memory:propose",
): PrepareVaultAccess {
  return async (tx) => {
    await requireVaultActive(tx);
    const context = await requireInstallationCredential(tx, tokenId, action);

    if (!context.memoryEnabled)
      throw new MaisterError(
        "PRECONDITION",
        "Installation agent memory is disabled",
      );
    const vaultId = await ensureInstallationVault(
      tx,
      context.companyId,
      context.agentId,
    );
    const runProjects = await installationRunProjects(tx, context.runId);

    if (!(await seesEveryProject(tx, context, runProjects)))
      throw unavailableMemory();
    const principal = {
      kind: "execution" as const,
      runId: context.runId,
      nodeAttemptId: null,
    };
    const consumer = await lockKnowledgeReadConsumer(tx, principal);
    const sourceRestrictions = consumer?.capture.restrictions ?? [];

    return {
      vaultId,
      principalKey: `agent:${context.runId}:installation`,
      actor: {
        kind: "agent_session",
        agentId: context.agentId,
        runId: context.runId,
        sessionKey: context.runId,
        nodeAttemptId: null,
      },
      sourceProjectIds: runProjects,
      sourceRestrictions,
      writeAdmission: "review_required",
      visibleGeneration: true,
      canRead: (db, revision) =>
        canReadInstallationRevision(db, context, revision),
      resolveLinkSources: (db, content) =>
        installationLinkSources(
          db,
          {
            principal,
            authority: context,
            vaultId,
            priorProjects: runProjects,
            canRead: (tx, revision) =>
              canReadInstallationRevision(tx, context, revision),
          },
          content,
        ),
      async capture(db, revisions) {
        const references = revisions.flatMap((revision) =>
          revision.contentSha256
            ? [
                {
                  kind: "agent_vault_revision_v1" as const,
                  vaultId: revision.vaultId,
                  noteId: revision.noteId,
                  revisionId: revision.id,
                  contentSha256: revision.contentSha256,
                },
              ]
            : [],
        );

        await captureInstallationProjects(
          db,
          context.runId,
          revisions.flatMap(({ sourceProjectIds }) => sourceProjectIds),
        );
        await recordNativeRunSourcesInTransaction(
          db,
          context.runId,
          references,
        );
      },
    };
  };
}

export async function canReadInstallationRevision(
  tx: Db,
  context: InstallationRunAuthority,
  revision: VaultRevision,
): Promise<boolean> {
  if (!(await seesEveryProject(tx, context, revision.sourceProjectIds)))
    return false;
  try {
    await authorizeSourceRestrictions(
      tx,
      { kind: "execution", runId: context.runId, nodeAttemptId: null },
      normalizedSources(revision),
    );

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

function normalizedSources(revision: VaultRevision) {
  return revision.sourceRestrictions.map((source) =>
    source.kind === "legacy_project_private"
      ? { kind: "project_context" as const, projectId: source.projectId }
      : source,
  );
}

type InstallationVaultTarget = Readonly<{
  userId: string;
  agentId: string;
  bindingId: string;
  action: "read" | "edit";
}>;

export function prepareHumanInstallationVault(
  input: InstallationVaultTarget,
): PrepareVaultAccess {
  return async (tx) => {
    const { access, availability } = await authorizeHumanInstallationVault(
      tx,
      input,
    );

    if (availability !== "available") {
      const attachmentDisabled = availability === "disabled_attachment";

      throw new MaisterError(
        "PRECONDITION",
        attachmentDisabled
          ? "Installation agent attachment is disabled"
          : "Installation agent memory is disabled",
        {
          details: {
            reason: attachmentDisabled
              ? "agent_memory_attachment_disabled"
              : "agent_memory_disabled",
          },
        },
      );
    }

    return access;
  };
}

export async function authorizeHumanInstallationVault(
  tx: Db,
  input: InstallationVaultTarget,
) {
  await requireVaultActive(tx);
  const actor = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId: input.userId },
    "knowledge:read",
  );

  if (actor.kind !== "user") throw unavailableMemory();
  const result = await tx.execute<{
    company_id: string;
    availability: VaultBindingAvailability;
  }>(sql`
      SELECT b.company_id, ${installationVaultAvailability(sql`b.enabled`, sql`v.snapshot`)} AS availability
      FROM company_specialist_bindings b JOIN company_specialist_binding_revisions v
        ON (v.binding_id,v.revision)=(b.id,b.revision)
      WHERE b.id=${input.bindingId} AND b.agent_id=${input.agentId} AND b.detached_at IS NULL
        AND v.snapshot->'installationGrant'->>'reach'='active_projects' FOR SHARE OF b,v
    `);
  const binding = result.rows[0];

  if (!binding) throw unavailableMemory();
  if (actor.user.role !== "admin")
    await authorizeCompanyUserAction(
      tx,
      input.userId,
      binding.company_id,
      "specialists:read",
    );
  if (input.action === "edit" && actor.user.role !== "admin")
    throw unavailableMemory();
  const vaultId = await ensureInstallationVault(
    tx,
    binding.company_id,
    input.agentId,
  );
  const canReadSourceProjects = async (
    db: Db,
    projectIds: readonly string[],
  ): Promise<boolean> => {
    if (actor.user.role === "admin" || projectIds.length === 0) return true;
    const ids = [...new Set(projectIds)].sort();
    const { rows } = await db.execute(sql`
      SELECT p.id FROM projects p JOIN project_members m ON m.project_id=p.id
      WHERE m.user_id=${input.userId} AND p.id=ANY(${sql.param(ids)}::text[])
        AND p.archived_at IS NULL
      ORDER BY p.id FOR SHARE OF p,m
    `);

    return rows.length === ids.length;
  };

  const access: Awaited<ReturnType<PrepareVaultAccess>> = {
    vaultId,
    principalKey: `user:${input.userId}`,
    actor: { kind: "human", userId: input.userId },
    sourceProjectIds: [],
    sourceRestrictions: [],
    writeAdmission: "apply",
    visibleGeneration: true,
    async canRead(db, revision) {
      if (actor.user.role === "admin") return true;
      if (!(await canReadSourceProjects(db, revision.sourceProjectIds)))
        return false;
      try {
        await authorizeSourceRestrictions(
          db,
          { kind: "user", userId: input.userId },
          normalizedSources(revision),
        );

        return true;
      } catch (error) {
        if (
          isMaisterError(error) &&
          ["PRECONDITION", "UNAUTHORIZED"].includes(error.code)
        )
          return false;
        throw error;
      }
    },
    capture: async () => {},
    resolveLinkSources: (db, content) =>
      installationLinkSources(
        db,
        {
          principal: { kind: "user", userId: input.userId },
          vaultId,
          priorProjects: [],
          canRead: access.canRead,
        },
        content,
      ),
  };

  return { access, availability: binding.availability, canReadSourceProjects };
}
