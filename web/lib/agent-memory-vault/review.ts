import "server-only";

import type { PendingVaultProposal } from "./proposals";
import type { VaultAccess } from "./store";
import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";

import { parseAgentMemoryMutation } from "./commands";
import { agentMemoryVaultLimits } from "./limits";
import { authorizeRetainedProjectVaultReview } from "./project-access";
import { vaultProposalBases } from "./proposals";
import {
  applyVaultMutationInTransaction,
  lockVault,
  readVaultPayload,
  unavailableMemory,
} from "./store";

import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import {
  agentMemoryProposalPayloads as payloads,
  agentMemoryProposals as proposals,
  agentMemoryVaults as vaults,
  projects,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

export async function lockProjectVaultReview(
  tx: Db,
  proposalId: string,
  userId: string,
): Promise<{
  reviewer: VaultAccess;
  proposal: PendingVaultProposal;
  enabled: boolean;
}> {
  const [owner] = await tx
    .select({
      slug: projects.slug,
      agentId: vaults.agentId,
      vaultId: vaults.id,
    })
    .from(proposals)
    .innerJoin(vaults, eq(vaults.id, proposals.vaultId))
    .innerJoin(projects, eq(projects.id, vaults.projectId))
    .where(eq(proposals.id, proposalId));
  if (!owner) throw unavailableMemory();

  try {
    const { reviewer, enabled } = await authorizeRetainedProjectVaultReview(tx, {
      userId,
      slug: owner.slug,
      agentId: owner.agentId,
    }, owner.vaultId);
    await lockVault(tx, owner.vaultId);
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(
        and(eq(proposals.id, proposalId), eq(proposals.vaultId, owner.vaultId)),
      )
      .for("update");
    if (
      !proposal ||
      proposal.state === "redacted" ||
      !proposal.sourceProjectIds.every((id) =>
        reviewer.sourceProjectIds.includes(id),
      )
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
    for (const revision of await vaultProposalBases(
      tx,
      owner.vaultId,
      proposal.operationId,
    )) {
      if (!(await reviewer.canRead(tx, revision))) throw unavailableMemory();
      if (revision.contentSha256 !== null) await readVaultPayload(tx, revision);
    }

    return { reviewer, proposal, enabled };
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
  const { reviewer, proposal, enabled } = await lockProjectVaultReview(
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
    if (!enabled) throw new MaisterError("CONFLICT", "Enable the vault before accepting this proposal");
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
