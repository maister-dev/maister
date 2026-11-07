import { z } from "zod";

import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { knowledgeRestrictionsSchema } from "@/lib/company/types";
import { humanAskBodySchema } from "@/lib/services/agent-question-contract";
import { postgresTextSchema } from "@/lib/text-schema";

/** Assignment clarification uses the existing human-question form grammar and no caller attribution. */
export const assignmentQuestionInputSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    question: postgresTextSchema.min(1).max(10000).regex(/\S/),
    schema: humanAskBodySchema.shape.schema,
    reTriggerMode: z.literal("agent").default("agent"),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

export type AssignmentQuestionInput = z.infer<
  typeof assignmentQuestionInputSchema
>;

/** Retained server provenance is distinct from the editable form and the existing owned prompt proof. */
export const assignmentQuestionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: postgresTextSchema.min(1).max(128),
    inputRevision: knowledgeRevisionSchema,
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    contextRevision: z.number().int().min(0).max(2147483647),
    expectedRevision: knowledgeRevisionSchema,
    principalKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestKey: knowledgeDeliveryKeySchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    actor: knowledgeActorSchema.safeExtend({
      kind: z.enum(["user", "agent"]),
      id: postgresTextSchema.min(1).max(192),
    }),
    sourceRestrictions: knowledgeRestrictionsSchema,
  })
  .strict();

export type AssignmentQuestionSnapshot = z.infer<
  typeof assignmentQuestionSnapshotSchema
>;

export const assignmentQuestionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: postgresTextSchema.min(1).max(128),
    hitlRequestId: postgresTextSchema.min(1).max(128),
    sourceRunId: postgresTextSchema.min(1).max(128),
    inputRevision: knowledgeRevisionSchema,
    activationState: z.enum(["pending_termination", "active", "failed"]),
    created: z.boolean(),
  })
  .strict();

export type AssignmentQuestionReceipt = z.infer<
  typeof assignmentQuestionReceiptSchema
>;
