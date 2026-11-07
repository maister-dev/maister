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
} as const;

export const knowledgeToolEffects =
  NATIVE_KNOWLEDGE_TOOL_EFFECTS satisfies Readonly<
    Record<keyof typeof knowledgeToolInputSchemas, "read" | "write">
  >;
