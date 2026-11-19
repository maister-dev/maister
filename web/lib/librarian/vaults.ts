import "server-only";

import type { PrepareVaultAccess } from "@/lib/agent-memory-vault/store";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { lockLibrarianKnowledgeContext } from "./knowledge-authority";

import { requireVaultActive } from "@/lib/agent-memory-vault/cutover";
import { prepareHumanInstallationVault } from "@/lib/agent-memory-vault/installation-access";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import { unavailableMemory } from "@/lib/agent-memory-vault/store";
import { projectRolesForActions } from "@/lib/authz";
import { recordKnowledgeDisclosure } from "@/lib/brain/knowledge-disclosure";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

const namespace = "maister.librarian.vault-list.v1";
const cursorContract = z.strictObject({
  owner: z.string().min(1).max(192),
  after: z.uuid(),
});
const identity = z.string().min(1).max(192);

type VaultTarget = Readonly<{
  id: string;
  agent_id: string;
  company_id: string | null;
  project_id: string | null;
  slug: string | null;
  binding_id: string | null;
  owner_label: string;
}>;

export async function resolveLibrarianVault(
  tx: Db,
  userId: string,
  vaultId: string,
  action: "edit" | "read",
) {
  if (!identity.safeParse(vaultId).success) throw unavailableMemory();
  const [target] = (
    await tx.execute<VaultTarget>(sql`
    SELECT v.id,v.agent_id,v.project_id,v.company_id,p.slug,b.id AS binding_id,
      coalesce(p.name,'Installation') AS owner_label
    FROM agent_memory_vaults v LEFT JOIN projects p ON p.id=v.project_id
    LEFT JOIN company_specialist_bindings b ON b.company_id=v.company_id AND b.agent_id=v.agent_id AND b.detached_at IS NULL
    WHERE v.id=${vaultId}
  `)
  ).rows;
  if (!target) throw unavailableMemory();

  try {
    const access = target.slug
      ? await prepareHumanProjectVault({
          userId,
          slug: target.slug,
          agentId: target.agent_id,
          action: action === "edit" ? "editSettings" : "readRepoFiles",
        })(tx)
      : target.binding_id
        ? await prepareHumanInstallationVault({
            userId,
            bindingId: target.binding_id,
            agentId: target.agent_id,
            action,
          })(tx)
        : null;
    if (!access || access.vaultId !== vaultId) throw unavailableMemory();

    return { access, target };
  } catch (error) {
    if (
      isMaisterError(error) &&
      ["PRECONDITION", "UNAUTHORIZED"].includes(error.code)
    )
      throw unavailableMemory();
    throw error;
  }
}

export function prepareLibrarianVault(
  tokenId: string,
  vaultId: string,
): PrepareVaultAccess {
  return async (tx) => {
    const { ownerId, turnId, capture } = await lockLibrarianKnowledgeContext(
      tx,
      tokenId,
      "agent_memory:read",
    );
    const { access, target } = await resolveLibrarianVault(
      tx,
      ownerId,
      vaultId,
      "read",
    );

    return {
      ...access,
      principalKey: `librarian:${turnId}`,
      async capture(db, revisions) {
        const restrictions: KnowledgeAccessRestriction[] = target.project_id
          ? [{ kind: "project_context", projectId: target.project_id }]
          : [];
        for (const revision of revisions) {
          if (revision.contentSha256)
            restrictions.push({
              kind: "agent_vault_revision_v1",
              vaultId: revision.vaultId,
              noteId: revision.noteId,
              revisionId: revision.id,
              contentSha256: revision.contentSha256,
            });
          else
            restrictions.push(
              ...revision.sourceProjectIds.map((projectId) => ({
                kind: "project_visibility" as const,
                projectId,
              })),
            );
        }
        await recordKnowledgeDisclosure(
          db,
          { runId: null, librarianTurnId: turnId, capture },
          restrictions,
        );
      },
    };
  };
}

export async function listLibrarianVaults(
  db: Db,
  tokenId: string,
  limit: number,
  cursor: string | undefined,
) {
  return db.transaction(async (tx) => {
    await requireVaultActive(tx);
    const { ownerId, turnId, capture } = await lockLibrarianKnowledgeContext(
      tx,
      tokenId,
      "agent_memory:read",
    );
    const after = cursor
      ? cursorContract.safeParse(parseCursorPayload(namespace, cursor))
      : null;
    if (after && (!after.success || after.data.owner !== ownerId))
      throw new MaisterError(
        "CONFIG",
        "The vault cursor belongs to another owner",
      );
    const roles = sql.join(
      projectRolesForActions(["readRepoFiles"]).map((role) => sql`${role}`),
      sql`, `,
    );
    const { rows } = await tx.execute<VaultTarget>(sql`
      SELECT v.id,v.agent_id,v.project_id,v.company_id,p.slug,b.id AS binding_id,
        coalesce(p.name,'Installation') AS owner_label
      FROM agent_memory_vaults v JOIN users u ON u.id=${ownerId}
      LEFT JOIN projects p ON p.id=v.project_id AND p.archived_at IS NULL
      LEFT JOIN agent_project_links l ON l.project_id=p.id AND l.agent_id=v.agent_id AND l.enabled AND l.memory_enabled
      LEFT JOIN company_specialist_bindings b ON b.company_id=v.company_id AND b.agent_id=v.agent_id AND b.detached_at IS NULL
      LEFT JOIN company_specialist_binding_revisions reviewed ON (reviewed.binding_id,reviewed.revision)=(b.id,b.revision)
      WHERE (
        (l.project_id IS NOT NULL AND (u.role='admin' OR EXISTS (SELECT 1 FROM project_members m
          WHERE m.user_id=u.id AND m.project_id=p.id AND m.role IN (${roles}) FOR SHARE)))
        OR (reviewed.snapshot->'installationGrant'->>'memoryEnabled'='true' AND (u.role='admin' OR EXISTS (
          SELECT 1 FROM company_grants g WHERE g.company_id=v.company_id AND g.principal_type='user'
            AND g.principal_id=u.id AND g.action='specialists:read' AND g.revoked_at IS NULL FOR SHARE)))
      ) ${after?.success ? sql`AND v.id COLLATE "C">${after.data.after}` : sql``}
      ORDER BY v.id COLLATE "C" LIMIT ${limit + 1}
    `);
    await recordKnowledgeDisclosure(
      tx,
      { runId: null, librarianTurnId: turnId, capture },
      rows.flatMap(({ project_id }) =>
        project_id
          ? [{ kind: "project_context" as const, projectId: project_id }]
          : [],
      ),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      items: page.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        ownerKind: row.project_id ? "project" : "installation",
        ownerLabel: row.owner_label.slice(0, 256),
      })),
      nextCursor:
        last && rows.length > limit
          ? signCursorPayload(namespace, { owner: ownerId, after: last.id })
          : null,
    };
  });
}
