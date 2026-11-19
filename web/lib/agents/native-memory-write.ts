import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { VaultRevision } from "@/lib/agent-memory-vault/store";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";

import { writeAgentMemoryCas } from "./memory-store";

import {
  canonicalKnowledgeRestrictions,
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { usesNativeKnowledgeTransport } from "@/lib/brain/knowledge-execution-access";
import {
  authorizeSourceRestrictions,
  unavailableKnowledgeReference,
} from "@/lib/brain/knowledge-restrictions";
import { unavailableMemory } from "@/lib/agent-memory-vault/store";
import { MaisterError } from "@/lib/errors";

type ExecutionMemoryWrite = Readonly<{
  runId: string | null;
  tokenId: string;
  projectId: string;
  projectSlug: string;
  agentId: string;
  content: string;
  ifHash: string | null;
}>;

type ExecutionMemoryOwner = Readonly<{
  tokenId: string;
  runId: string;
  projectId: string;
  agentId: string;
  vaultId: string;
}>;

export function exactVaultSources(
  revisions: readonly VaultRevision[],
): KnowledgeAccessRestriction[] {
  return revisions.flatMap((revision): KnowledgeAccessRestriction[] =>
    revision.contentSha256 === null
      ? [
          ...revision.sourceProjectIds.map((projectId) => ({
            kind: "project_context" as const,
            projectId,
          })),
          ...revision.sourceRestrictions.map((ref) =>
            ref.kind === "legacy_project_private"
              ? { kind: "project_context" as const, projectId: ref.projectId }
              : ref,
          ),
        ]
      : [
          {
            kind: "agent_vault_revision_v1",
            vaultId: revision.vaultId,
            noteId: revision.noteId,
            revisionId: revision.id,
            contentSha256: revision.contentSha256,
          },
        ],
  );
}

/** Lock the native consumer before the vault lock, preserving the existing private write ceiling. */
export async function prepareNativeVaultSources(
  tx: Db,
  owner: ExecutionMemoryOwner,
) {
  if (!(await usesNativeKnowledgeTransport(tx, owner.runId)))
    return { restrictions: [], allowWrite: () => {}, capture: async () => {} };

  const principal = { kind: "token" as const, tokenId: owner.tokenId };
  const consumer = await lockKnowledgeReadConsumer(tx, principal);

  if (!consumer || consumer.runId !== owner.runId) throw unavailableMemory();
  await resolveKnowledgePrincipal(tx, principal, "knowledge:read");
  const restrictions = consumer.capture.restrictions;

  return {
    restrictions,
    allowWrite() {
      const safe = restrictions.every(
        (source) =>
          (source.kind === "project_context" &&
            source.projectId === owner.projectId) ||
          (source.kind === "agent_memory" &&
            source.projectId === owner.projectId &&
            source.agentId === owner.agentId) ||
          (source.kind === "agent_vault_revision_v1" &&
            source.vaultId === owner.vaultId),
      );

      if (!safe)
        throw new MaisterError(
          "PRECONDITION",
          "Private notes cannot retain this execution's additional source restrictions",
          { details: { reason: "native_unclassified_memory" } },
        );
    },
    async capture(db: Db, delivered: readonly VaultRevision[]) {
      const sources = exactVaultSources(delivered);

      await authorizeSourceRestrictions(
        db,
        principal,
        canonicalKnowledgeRestrictions([...restrictions, ...sources]),
      );
      await recordKnowledgeDisclosure(db, consumer, sources);
    },
  };
}

/** Serialize source admission with the existing file CAS, preserving private memory's own policy. */
export async function writeExecutionAgentMemory(
  db: Db,
  input: ExecutionMemoryWrite,
): Promise<Awaited<ReturnType<typeof writeAgentMemoryCas>>> {
  return db.transaction(async (tx) => {
    if (
      input.runId !== null &&
      (await usesNativeKnowledgeTransport(tx, input.runId))
    ) {
      const principal = { kind: "token" as const, tokenId: input.tokenId };
      const consumer = await lockKnowledgeReadConsumer(tx, principal);

      if (!consumer || consumer.runId !== input.runId)
        throw unavailableKnowledgeReference();
      await resolveKnowledgePrincipal(tx, principal, "knowledge:read");
      const safeSources = consumer.capture.restrictions.every(
        (source) =>
          (source.kind === "project_context" &&
            source.projectId === input.projectId) ||
          (source.kind === "agent_memory" &&
            source.projectId === input.projectId &&
            source.agentId === input.agentId),
      );

      if (!safeSources)
        throw new MaisterError(
          "PRECONDITION",
          "Private notes cannot retain the current execution's additional source restrictions. Return findings or propose structured knowledge instead.",
          { details: { reason: "native_unclassified_memory" } },
        );
      await authorizeSourceRestrictions(
        tx,
        principal,
        consumer.capture.restrictions,
      );
    }

    return writeAgentMemoryCas(
      tx,
      input.projectSlug,
      input.agentId,
      input.content,
      input.ifHash,
    );
  });
}
