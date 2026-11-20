import "server-only";

import type { AgentMemoryMutation } from "./commands";
import type { VaultAccess, VaultRevision } from "./store";
import type {
  AgentMemoryProposedChange,
  AgentMemoryRestriction,
} from "./types";
import type { Db } from "@/lib/execution-host/db";

import { and, count, eq } from "drizzle-orm";

import {
  agentMemoryOperationRevisions as operationRevisions,
  agentMemoryOperations as operations,
  agentMemoryProposalPayloads as payloads,
  agentMemoryProposals as proposals,
  agentMemoryRevisions as revisions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type VaultPending = Readonly<{
  status: "pending";
  operationId: string;
  proposalId: string;
}>;
export type PendingVaultProposal = typeof proposals.$inferSelect;

export async function retainVaultProposal(
  tx: Db,
  input: Readonly<{
    operationId: string;
    digest: string;
    command: AgentMemoryMutation;
    changes: AgentMemoryProposedChange[];
    sourceProjectIds: string[];
    sourceRestrictions: AgentMemoryRestriction[];
    refs: readonly VaultRevision[];
    access: VaultAccess;
    maxPending: number;
  }>,
): Promise<VaultPending> {
  const { operationId, command, access } = input;
  const [{ pending } = { pending: 0 }] = await tx
    .select({ pending: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.vaultId, access.vaultId),
        eq(proposals.state, "pending"),
      ),
    );

  if (pending >= input.maxPending)
    throw new MaisterError("CONFIG", "Pending vault proposal limit reached");
  await tx.insert(operations).values({
    id: operationId,
    vaultId: access.vaultId,
    principalKey: access.principalKey,
    requestKey: command.requestKey,
    commandKind: command.command,
    commandDigest: input.digest,
    outcome: "pending",
  });
  const [proposal] = await tx
    .insert(proposals)
    .values({
      vaultId: access.vaultId,
      operationId,
      author: access.actor,
      changes: input.changes,
      sourceProjectIds: input.sourceProjectIds,
      sourceRestrictions: input.sourceRestrictions,
    })
    .returning({ id: proposals.id });

  if (!proposal)
    throw new MaisterError("CRASH", "Vault proposal was not stored");
  await tx
    .insert(payloads)
    .values({ vaultId: access.vaultId, proposalId: proposal.id, command });
  if (input.refs.length > 0)
    await tx.insert(operationRevisions).values(
      input.refs.map((ref, ordinal) => ({
        vaultId: access.vaultId,
        operationId,
        role: "base" as const,
        ordinal,
        noteId: ref.noteId,
        revisionId: ref.id,
      })),
    );

  return { status: "pending", operationId, proposalId: proposal.id };
}

export async function vaultProposalBases(
  tx: Db,
  vaultId: string,
  operationId: string,
): Promise<VaultRevision[]> {
  const records = await tx
    .select({ revision: revisions })
    .from(operationRevisions)
    .innerJoin(
      revisions,
      and(
        eq(operationRevisions.vaultId, revisions.vaultId),
        eq(operationRevisions.noteId, revisions.noteId),
        eq(operationRevisions.revisionId, revisions.id),
      ),
    )
    .where(
      and(
        eq(operationRevisions.vaultId, vaultId),
        eq(operationRevisions.operationId, operationId),
        eq(operationRevisions.role, "base"),
      ),
    )
    .orderBy(operationRevisions.ordinal);

  return records.map(({ revision }) => revision);
}

export async function findVaultProposal(
  tx: Db,
  vaultId: string,
  operationId: string,
) {
  const [proposal] = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.vaultId, vaultId),
        eq(proposals.operationId, operationId),
      ),
    );

  return proposal;
}
