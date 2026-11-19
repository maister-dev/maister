import "server-only";

import type { AgentMemoryState } from "@/lib/agents/memory-store";
import type { Db } from "@/lib/execution-host/db";
import type { PrepareVaultAccess, VaultAccess } from "./store";

import { randomUUID } from "node:crypto";

import { parseAgentMemoryMutation } from "./commands";
import { agentMemoryVaultLimits } from "./limits";
import { MEMORY_INDEX } from "./paths";
import {
  applyVaultMutationInTransaction,
  loadActiveHeads,
  lockVault,
  readVaultPayload,
  unavailableMemory,
} from "./store";

import { MaisterError } from "@/lib/errors";

async function indexHead(db: Db, access: VaultAccess) {
  await lockVault(db, access.vaultId);
  const index = (await loadActiveHeads(db, access.vaultId)).find(
    ({ note }) => note.path === MEMORY_INDEX,
  );

  if (index && !(await access.canRead(db, index.revision)))
    throw unavailableMemory();

  return index;
}

async function indexState(
  db: Db,
  access: VaultAccess,
  head: Awaited<ReturnType<typeof indexHead>>,
): Promise<AgentMemoryState> {
  if (!head) return { content: "", hash: null, sizeChars: 0, updatedAt: null };
  const content = await readVaultPayload(db, head.revision);

  await access.capture(db, [head.revision]);

  return {
    content,
    hash: head.revision.contentSha256,
    sizeChars: head.revision.sizeChars,
    updatedAt: head.revision.createdAt,
  };
}

export async function readCompatibleVaultIndex(
  db: Db,
  prepare: PrepareVaultAccess,
): Promise<AgentMemoryState> {
  const access = await prepare(db);

  return indexState(db, access, await indexHead(db, access));
}

type IndexMutation = Readonly<{
  ifHash: string | null;
  content: string | null;
}>;
type IndexMutationResult =
  | Readonly<{ ok: true; state: AgentMemoryState }>
  | Readonly<{ ok: false; current: AgentMemoryState }>;

export async function mutateCompatibleVaultIndex(
  db: Db,
  prepare: PrepareVaultAccess,
  write: IndexMutation,
): Promise<IndexMutationResult> {
  const limits = agentMemoryVaultLimits();

  if (write.content !== null && write.content.length > limits.indexChars)
    throw new MaisterError(
      "CONFIG",
      "Memory index exceeds its character limit",
    );
  const access = await prepare(db);
  const head = await indexHead(db, access);

  if ((head?.revision.contentSha256 ?? null) !== write.ifHash)
    return { ok: false, current: await indexState(db, access, head) };
  if (write.content === null && !head)
    return { ok: true, state: await indexState(db, access, undefined) };
  const shared = {
    path: MEMORY_INDEX,
    requestKey: randomUUID(),
    ifRevisionId: head?.revision.id ?? null,
    ifHash: write.ifHash,
  };
  const result = await applyVaultMutationInTransaction(
    db,
    parseAgentMemoryMutation(
      write.content === null
        ? { command: "delete", ...shared }
        : { command: "create", ...shared, file_text: write.content },
    ),
    async () => access,
    limits,
  );

  if (result.status !== "applied")
    throw new MaisterError(
      "CRASH",
      "Index compare and swap changed under vault lock",
    );
  // The command already recorded this disclosure in the same transaction.
  const next = await indexHead(db, access);

  return {
    ok: true,
    state:
      next && write.content !== null
        ? {
            content: write.content,
            hash: next.revision.contentSha256,
            sizeChars: next.revision.sizeChars,
            updatedAt: next.revision.createdAt,
          }
        : { content: "", hash: null, sizeChars: 0, updatedAt: null },
  };
}
