import { z } from "zod";

import { NATIVE_KNOWLEDGE_TOOL_EFFECTS } from "../../../runtime/knowledge-tool-effects";

import {
  knowledgePageInputSchema,
  knowledgeSearchSchema,
  knowledgeSourceCaptureSchema,
} from "./knowledge-read-types";
import {
  knowledgeProposalInputSchema,
  knowledgeProposalDecisionSchema,
  knowledgeConfirmationInputSchema,
  knowledgeProposalListSchema,
} from "./knowledge-write-types";
import { knowledgeRevisionSchema } from "./knowledge-types";

import { postgresTextSchema } from "@/lib/text-schema";
import {
  assignmentContextReadSchema,
  assignmentContextUpdateSchema,
} from "@/lib/specialist-assignments/context-types";
import {
  assignmentQuestionInputSchema,
  assignmentQuestionResponseSchema,
} from "@/lib/specialist-assignments/question-types";

const record = z
  .object({
    recordId: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema.optional(),
  })
  .strict();
const humanIdentity = postgresTextSchema.min(1).max(192);
const humanCursor = z.string().min(1).max(2048).optional();
const humanPage = {
  limit: z.int().min(1).max(100).optional(),
  cursor: humanCursor,
};
const humanOwners = {
  projectId: humanIdentity.optional(),
  companyId: humanIdentity.optional(),
  agentId: humanIdentity.optional(),
};
const humanKind = z.enum(["vault", "brain", "knowledge"]);
const humanLocation = { locationId: humanIdentity };

/** Generated facade schemas and native handlers share these nested input definitions. */
export const knowledgeToolInputSchemas = {
  // The native facade shares validation; assignment context remains a separate durable store.
  assignment_get: assignmentContextReadSchema.omit({ revision: true }),
  assignment_question_ask: assignmentQuestionInputSchema.extend({
    assignmentId: assignmentContextReadSchema.shape.assignmentId,
  }),
  assignment_question_respond: assignmentQuestionResponseSchema.extend({
    assignmentId: assignmentContextReadSchema.shape.assignmentId,
    questionId: assignmentContextReadSchema.shape.assignmentId,
  }),
  assignment_context_get: assignmentContextReadSchema,
  assignment_context_update: assignmentContextUpdateSchema.safeExtend({
    assignmentId: assignmentContextReadSchema.shape.assignmentId,
  }),
  knowledge_search: knowledgeSearchSchema,
  knowledge_get: record,
  knowledge_evidence: record.extend(knowledgePageInputSchema.shape).strict(),
  knowledge_conflicts: record.extend(knowledgePageInputSchema.shape).strict(),
  knowledge_capture_source: knowledgeSourceCaptureSchema,
  knowledge_witness_get: z
    .object({ witnessId: postgresTextSchema.min(1).max(128) })
    .strict(),
  knowledge_propose: knowledgeProposalInputSchema,
  knowledge_proposal_get: z
    .object({ proposalId: postgresTextSchema.min(1).max(128) })
    .strict(),
  knowledge_proposals_list: knowledgeProposalListSchema,
  knowledge_decide: knowledgeProposalDecisionSchema
    .extend({ proposalId: postgresTextSchema.min(1).max(128) })
    .strict(),
  knowledge_confirm: knowledgeConfirmationInputSchema
    .extend({ recordId: postgresTextSchema.min(1).max(128) })
    .strict(),
  proposal_reviews_list: z.strictObject({
    view: z.enum(["pending", "history"]).optional(),
    kind: humanKind.optional(),
    ...humanOwners,
    ...humanPage,
  }),
  proposal_review_get: z.strictObject({
    kind: humanKind,
    proposalId: humanIdentity,
    cursor: humanCursor,
    outcomeCursor: humanCursor,
  }),
  proposal_review_decide: z.strictObject({
    kind: z.enum(["brain", "vault"]),
    proposalId: humanIdentity,
    expectedVersion: z.string().min(1).max(128),
    requestKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]{8,128}$/),
    decision: z.enum(["accept", "reject"]),
    reason: postgresTextSchema.min(1).max(2000).optional(),
  }),
  personal_vault_list: z.strictObject({ ...humanOwners, ...humanPage }),
  personal_vault_view: z.union([
    z.strictObject({
      ...humanLocation,
      path: postgresTextSchema.min(1).max(512),
      ...humanPage,
    }),
    z.strictObject({
      ...humanLocation,
      noteId: humanIdentity,
      cursor: humanCursor,
    }),
  ]),
  personal_vault_revisions: z.strictObject({
    ...humanLocation,
    noteId: humanIdentity,
    ...humanPage,
  }),
  personal_vault_revision_get: z.strictObject({
    ...humanLocation,
    noteId: humanIdentity,
    revisionId: humanIdentity,
  }),
  knowledge_revisions_list: z.strictObject({
    recordId: record.shape.recordId,
    ...humanPage,
  }),
} as const;

export const knowledgeToolEffects =
  NATIVE_KNOWLEDGE_TOOL_EFFECTS satisfies Readonly<
    Record<keyof typeof knowledgeToolInputSchemas, "read" | "write">
  >;
