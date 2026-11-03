import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { writeAgentMemoryCas } from "./memory-store";

import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { usesNativeKnowledgeTransport } from "@/lib/brain/knowledge-execution-access";
import {
  authorizeSourceRestrictions,
  unavailableKnowledgeReference,
} from "@/lib/brain/knowledge-restrictions";
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
