import "server-only";

import type { KnowledgeDatabase } from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeProposalInput } from "./knowledge-write-types";
import type { KnowledgeProposalReceipt } from "./knowledge-proposals";

import { createKnowledgeProposal } from "./knowledge-proposals";
import { getKnowledgeRecord } from "./knowledge-records";
import { knowledgeProposalInputSchema } from "./knowledge-write-types";

import { MaisterError } from "@/lib/errors";

/** Correction ownership is resolved from the current referenced record; clients cannot reassign it. */
export async function submitKnowledgeProposal(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  input: KnowledgeProposalInput,
): Promise<KnowledgeProposalReceipt> {
  const parsed = knowledgeProposalInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid structured knowledge proposal input",
    );
  const { content, idempotencyKey } = parsed.data;

  if (content.change === "add") {
    const { change: _change, owner, ...draft } = content;

    return createKnowledgeProposal(db, {
      kind: "knowledge_add",
      owner,
      principal,
      draft,
      idempotencyKey,
    });
  }
  const { change: _change, recordId, expectedRevision, ...draft } = content;
  const record = await getKnowledgeRecord(db, principal, {
    recordId,
    revision: expectedRevision,
  });

  return createKnowledgeProposal(db, {
    kind: "knowledge_correct",
    owner: record.owner,
    principal,
    draft,
    idempotencyKey,
    targetRecordId: recordId,
    expectedRecordRevision: expectedRevision,
  });
}

export function knowledgeProposalHttpReceipt(
  receipt: KnowledgeProposalReceipt,
): {
  id: string;
  revision: number;
  status: "pending" | "accepted" | "rejected";
  duplicate: boolean;
} {
  return {
    id: receipt.id,
    revision: receipt.revision,
    status: receipt.status,
    duplicate: receipt.duplicate,
  };
}
