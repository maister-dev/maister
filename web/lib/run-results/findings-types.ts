import { z } from "zod";

import {
  knowledgeDraftSchema,
  knowledgeReferenceSchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { knowledgeProposalContentSchema } from "@/lib/brain/knowledge-write-types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

/** Exact finding identity within a direct child's retained public result. */
export const sourceFindingSchema = z
  .object({
    childRunId: identity,
    resultRevision: knowledgeRevisionSchema,
    findingId: identity,
  })
  .strict();

export const evidenceFindingSchema = z
  .object({
    id: identity,
    assertion: postgresTextSchema.min(1).max(2000),
    basis: knowledgeDraftSchema.shape.basis,
    supporting: z.array(knowledgeReferenceSchema).max(64),
    contradicting: z.array(knowledgeReferenceSchema).max(64),
    missingEvidence: knowledgeDraftSchema.shape.missingEvidence,
    limitations: knowledgeDraftSchema.shape.limitations,
    openQuestions: z.array(postgresTextSchema.min(1).max(1000)).max(32),
    sourceFindings: z.array(sourceFindingSchema).max(64),
  })
  .strict();

export const findingSelectionSchema = sourceFindingSchema
  .extend({
    disposition: z.enum(["retained", "combined", "omitted"]),
    outputFindingIds: z.array(identity).max(32),
    reason: postgresTextSchema.min(1).max(1000).optional(),
  })
  .strict();

/** Producer data only. Authority, source access and resolved availability are server state. */
export const evidenceFindingsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z.array(evidenceFindingSchema).max(32),
    knowledgeProposals: z.array(knowledgeProposalContentSchema).max(16),
    selection: z.array(findingSelectionSchema).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();

    for (const [index, finding] of value.findings.entries()) {
      if (identities.has(finding.id))
        context.addIssue({
          code: "custom",
          path: ["findings", index, "id"],
          message: "Finding identities must be unique within one public result",
        });
      identities.add(finding.id);
    }
  });

export type SourceFinding = z.infer<typeof sourceFindingSchema>;
export type EvidenceFinding = z.infer<typeof evidenceFindingSchema>;
export type FindingSelection = z.infer<typeof findingSelectionSchema>;
export type EvidenceFindingsV1 = z.infer<typeof evidenceFindingsV1Schema>;
