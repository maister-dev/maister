import { z } from "zod";

import {
  knowledgeDraftSchema,
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "./knowledge-types";

import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const reason = postgresTextSchema
  .min(1)
  .max(2000)
  .regex(/\S/, "An actionable reason is required");

export const knowledgeProposalContentSchema = z.discriminatedUnion("change", [
  knowledgeDraftSchema
    .extend({ change: z.literal("add"), owner: ownerSchema })
    .strict(),
  knowledgeDraftSchema
    .extend({
      change: z.literal("correct"),
      recordId: identity,
      expectedRevision: knowledgeRevisionSchema,
    })
    .strict(),
]);
export const knowledgeProposalInputSchema = z
  .object({
    content: knowledgeProposalContentSchema,
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export const knowledgeProposalDecisionSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    decision: z.enum(["accept", "reject"]),
    reason,
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export const knowledgeConfirmationInputSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    decision: z.enum(["confirm", "revoke"]),
    witnessIds: z.array(identity).max(64),
    reason,
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export type KnowledgeProposalInput = z.infer<
  typeof knowledgeProposalInputSchema
>;
export type KnowledgeProposalDecision = z.infer<
  typeof knowledgeProposalDecisionSchema
>;
export type KnowledgeConfirmationInput = z.infer<
  typeof knowledgeConfirmationInputSchema
>;

export const knowledgeProposalListSchema = z
  .object({
    owner: ownerSchema.optional(),
    status: z.enum(["pending", "accepted", "rejected"]).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type KnowledgeProposalList = z.infer<typeof knowledgeProposalListSchema>;

export const knowledgeMutationReceiptSchema = z
  .object({
    id: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema,
    status: z.enum(["pending", "accepted", "rejected", "confirmed", "revoked"]),
    duplicate: z.boolean(),
  })
  .strict();
