import { z } from "zod";

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

const record = z
  .object({
    recordId: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema.optional(),
  })
  .strict();

/** Generated facade schemas and native handlers share these nested input definitions. */
export const knowledgeToolInputSchemas = {
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
