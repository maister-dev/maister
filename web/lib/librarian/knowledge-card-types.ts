import { z } from "zod";

import { memoryMutation } from "@/lib/agent-memory-vault/commands";
import { knowledgeProposalContentSchema } from "@/lib/brain/knowledge-write-types";
import { knowledgeRestrictionsSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

export const knowledgeCardProposalSchemas = [
  z.strictObject({
    action: z.literal("knowledge_proposal"),
    content: knowledgeProposalContentSchema,
  }),
  z.strictObject({
    action: z.literal("brain_proposal"),
    projectSlug: postgresTextSchema.min(1).max(192),
    kind: z.enum(["rule", "skill", "flow", "adr", "roadmap", "state"]),
    evidenceItemIds: z
      .array(postgresTextSchema.min(1).max(192))
      .max(64)
      .default([]),
    draft: z.record(z.string(), z.unknown()),
    blastRadius: z.enum(["low", "medium", "high"]).default("low"),
  }),
  z.strictObject({
    action: z.literal("vault_edit"),
    vaultId: z.uuid(),
    command: memoryMutation,
  }),
] as const;

export type KnowledgeCardProposal = z.output<
  (typeof knowledgeCardProposalSchemas)[number]
>;

export function isKnowledgeCardProposal(value: {
  action: string;
}): value is KnowledgeCardProposal {
  return (
    value.action === "knowledge_proposal" ||
    value.action === "brain_proposal" ||
    value.action === "vault_edit"
  );
}

export const MAX_GOVERNED_PREVIEW_CHARS = 16_384;

export const effectContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turnId: z.string().min(1).max(192),
  contextEpoch: z.number().int().nonnegative(),
  restrictions: knowledgeRestrictionsSchema,
  preview: z.string().max(MAX_GOVERNED_PREVIEW_CHARS),
});
