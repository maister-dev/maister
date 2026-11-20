import "server-only";

import type { PendingVaultProposal } from "./proposals";
import type { VaultAccess, VaultRevision } from "./store";
import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray, sql } from "drizzle-orm";

import { parseAgentMemoryMutation } from "./commands";
import { authorizeHumanInstallationVault } from "./installation-access";
import { agentMemoryVaultLimits } from "./limits";
import { authorizeRetainedProjectVaultReview } from "./project-access";
import { vaultProposalBases } from "./proposals";
import {
  applyVaultMutationInTransaction,
  lockVault,
  unavailableMemory,
} from "./store";

import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import {
  agentMemoryProposalPayloads as payloads,
  agentMemoryProposals as proposals,
  agentMemoryRevisionPayloads as revisionPayloads,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

export async function lockVaultReview(
  tx: Db,
  proposalId: string,
  userId: string,
): Promise<{
  reviewer: VaultAccess;
  proposal: PendingVaultProposal;
  enabled: boolean;
  bases: VaultRevision[];
}> {
  const owner = (
    await tx.execute<{
      slug: string | null;
      agent_id: string;
      vault_id: string;
      binding_id: string | null;
    }>(sql`
    SELECT p.slug,v.agent_id,v.id AS vault_id,b.id AS binding_id
    FROM agent_memory_proposals proposal JOIN agent_memory_vaults v ON v.id=proposal.vault_id
    LEFT JOIN projects p ON p.id=v.project_id
    LEFT JOIN company_specialist_bindings b ON b.company_id=v.company_id AND b.agent_id=v.agent_id AND b.detached_at IS NULL
    LEFT JOIN company_specialist_binding_revisions revision ON (revision.binding_id,revision.revision)=(b.id,b.revision)
    WHERE proposal.id=${proposalId}
      AND (p.id IS NOT NULL OR revision.snapshot->'installationGrant'->>'reach'='active_projects')
  `)
  ).rows[0];

  if (!owner) throw unavailableMemory();

  try {
    const { reviewer, enabled } =
      owner.slug !== null
        ? await authorizeRetainedProjectVaultReview(
            tx,
            { userId, slug: owner.slug, agentId: owner.agent_id },
            owner.vault_id,
          )
        : await authorizeHumanInstallationVault(tx, {
            userId,
            agentId: owner.agent_id,
            bindingId: owner.binding_id!,
            action: "edit",
          }).then(({ access, memoryEnabled }) => ({
            reviewer: access,
            enabled: memoryEnabled,
          }));

    await lockVault(tx, owner.vault_id);
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.id, proposalId),
          eq(proposals.vaultId, owner.vault_id),
        ),
      )
      .for("update");

    if (
      !proposal ||
      proposal.state === "redacted" ||
      (owner.slug !== null &&
        !proposal.sourceProjectIds.every((id) =>
          reviewer.sourceProjectIds.includes(id),
        ))
    )
      throw unavailableMemory();

    await authorizeSourceRestrictions(
      tx,
      { kind: "user", userId },
      proposal.sourceRestrictions.map((source) =>
        source.kind === "legacy_project_private"
          ? { kind: "project_context", projectId: source.projectId }
          : source,
      ),
    );
    const bases = await vaultProposalBases(
      tx,
      owner.vault_id,
      proposal.operationId,
    );

    for (const revision of bases) {
      if (!(await reviewer.canRead(tx, revision))) throw unavailableMemory();
    }
    const contentIds = bases
      .filter(({ contentSha256 }) => contentSha256 !== null)
      .map(({ id }) => id);

    if (contentIds.length > 0) {
      const content = await tx
        .select({ id: revisionPayloads.revisionId })
        .from(revisionPayloads)
        .where(
          and(
            eq(revisionPayloads.vaultId, owner.vault_id),
            inArray(revisionPayloads.revisionId, contentIds),
          ),
        );

      if (content.length !== new Set(contentIds).size)
        throw unavailableMemory();
    }

    return { reviewer, proposal, enabled, bases };
  } catch (error) {
    if (
      isMaisterError(error) &&
      (error.code === "PRECONDITION" || error.code === "UNAUTHORIZED")
    )
      throw unavailableMemory();
    throw error;
  }
}

export async function readVaultProposalCommand(
  tx: Db,
  proposal: PendingVaultProposal,
) {
  const [payload] = await tx
    .select({ command: payloads.command })
    .from(payloads)
    .where(
      and(
        eq(payloads.vaultId, proposal.vaultId),
        eq(payloads.proposalId, proposal.id),
      ),
    );

  if (!payload) throw unavailableMemory();

  return parseAgentMemoryMutation(payload.command);
}

export type VaultReviewDecision = Readonly<{
  proposalId: string;
  userId: string;
  expectedVersion: number;
  decision: "accept" | "reject";
  requestKey: string;
}>;

export async function decideVaultProposal(db: Db, input: VaultReviewDecision) {
  return db.transaction((tx) => decideVaultProposalInTransaction(tx, input));
}

export async function decideVaultProposalInTransaction(
  tx: Db,
  input: VaultReviewDecision,
) {
  const { reviewer, proposal, enabled } = await lockVaultReview(
    tx,
    input.proposalId,
    input.userId,
  );
  const state = input.decision === "accept" ? "accepted" : "rejected";

  if (proposal.state === state)
    return {
      state,
      version: proposal.version,
      operationId: proposal.appliedOperationId,
    };
  if (
    proposal.state !== "pending" ||
    proposal.version !== input.expectedVersion
  )
    throw new MaisterError(
      "CONFLICT",
      "Vault proposal changed while reviewing",
    );
  let operationId: string | null = null;

  if (state === "accepted") {
    if (!enabled)
      throw new MaisterError(
        "CONFLICT",
        "Enable the vault before accepting this proposal",
      );
    const command = await readVaultProposalCommand(tx, proposal);
    const applied = await applyVaultMutationInTransaction(
      tx,
      { ...command, requestKey: `review:${proposal.id}` },
      async () => ({
        ...reviewer,
        principalKey: `review:${proposal.id}`,
        actor: proposal.author,
        sourceProjectIds: proposal.sourceProjectIds,
        sourceRestrictions: proposal.sourceRestrictions,
        resolveLinkSources: undefined,
      }),
      agentMemoryVaultLimits(),
    );

    if (applied.status !== "applied")
      throw new MaisterError(
        "CONFLICT",
        "Vault proposal base changed while reviewing",
      );
    operationId = applied.operationId;
  }

  await tx
    .update(proposals)
    .set({
      state,
      appliedOperationId: operationId,
      version: proposal.version + 1,
      decidedAt: new Date(),
      reviewerId: input.userId,
      decisionKey: input.requestKey,
    })
    .where(eq(proposals.id, proposal.id));

  return { state, version: proposal.version + 1, operationId };
}
