import { z } from "zod";

import {
  knowledgeDraftSchema,
  knowledgeRevisionSchema,
  knowledgeDeliveryKeySchema,
} from "./knowledge-types";
import { KNOWLEDGE_KINDS } from "./record-types";

import { postgresTextSchema } from "@/lib/text-schema";
import { ownerSchema } from "@/lib/company/types";

const identity = postgresTextSchema.min(1).max(128);

export const knowledgeActorSchema = z
  .object({
    kind: z.enum(["user", "agent", "system", "legacy_unknown"]),
    id: postgresTextSchema.min(1).max(192).nullable(),
    runId: identity.nullable(),
    attemptId: identity.nullable(),
  })
  .strict();
export const knowledgeFreshnessSchema = z
  .object({
    state: z.enum(["current", "stale", "unknown"]),
    applicability: z.enum(["known", "unknown"]),
    observedAt: z.string().datetime().nullable(),
    sourceAt: z.string().datetime().nullable(),
    capturedAt: z.string().datetime(),
  })
  .strict();
export const knowledgeWitnessSchema = z
  .object({
    id: identity,
    sourceId: identity.nullable(),
    sourceVersion: postgresTextSchema.min(1).max(256).nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    selector: z.string().max(512),
    availability: z.enum([
      "available",
      "stale",
      "missing",
      "inaccessible",
      "unknown",
    ]),
    capturedAt: z.string().datetime(),
    observedAt: z.string().datetime().nullable(),
    sourceAt: z.string().datetime().nullable(),
    independenceGroupId: identity.nullable(),
    attribution: knowledgeActorSchema,
    excerpt: z.string().max(8192).nullable(),
    excerptTruncated: z.boolean(),
  })
  .strict();
const knowledgeEvidenceRelationSchema = z.enum([
  "supports",
  "contradicts",
  "derived_from",
  "refines",
  "references",
]);
const unavailableEvidenceSchema = z
  .object({
    state: z.enum(["missing", "inaccessible", "unknown"]),
    reasonCode: z.enum([
      "record_evidence_missing",
      "proposal_source_capture_missing",
    ]),
    reason: postgresTextSchema.min(1).max(1000),
  })
  .strict();

export const knowledgeWitnessSummarySchema = knowledgeWitnessSchema.omit({
  excerpt: true,
  excerptTruncated: true,
});
export const knowledgeRecordEvidenceSchema = z.union([
  z
    .object({
      relation: knowledgeEvidenceRelationSchema,
      witness: knowledgeWitnessSchema,
    })
    .strict(),
  z
    .object({
      relation: knowledgeEvidenceRelationSchema,
      unavailable: unavailableEvidenceSchema,
    })
    .strict(),
]);
export const knowledgeRecordEvidenceSummarySchema = z.union([
  z
    .object({
      relation: knowledgeEvidenceRelationSchema,
      witness: knowledgeWitnessSummarySchema,
    })
    .strict(),
  z
    .object({
      relation: knowledgeEvidenceRelationSchema,
      unavailable: unavailableEvidenceSchema,
    })
    .strict(),
]);
export const knowledgeRecordSchema = z
  .object({
    id: identity,
    owner: ownerSchema,
    revision: knowledgeRevisionSchema,
    title: postgresTextSchema.min(1).max(256),
    assertion: postgresTextSchema.min(1).max(32000),
    assertionTruncated: z.boolean(),
    kind: z.enum(KNOWLEDGE_KINDS),
    basis: z.enum(["observed", "inferred", "unknown"]),
    lifecycle: z.enum(["active", "expired", "superseded", "withdrawn"]),
    visibility: z.enum(["owner_grants", "restricted"]),
    evidence: z.array(knowledgeRecordEvidenceSummarySchema).max(64),
    missingEvidence: knowledgeDraftSchema.shape.missingEvidence,
    confirmation: z
      .object({
        state: z.enum(["unconfirmed", "confirmed", "revoked"]),
        decisionId: identity.nullable(),
        policyVersion: z.number().int().positive().safe().nullable(),
        confirmer: knowledgeActorSchema.nullable(),
        witnessIds: z.array(identity).max(64),
      })
      .strict(),
    attribution: knowledgeActorSchema,
    freshness: knowledgeFreshnessSchema,
    limitations: z.array(postgresTextSchema.min(1).max(1000)).max(32),
    diagnostics: z
      .array(
        z.enum([
          "legacy_metadata_unknown",
          "legacy_writer_metadata_unknown",
          "historical_source_classification_unknown",
          "assertion_truncated",
          "accepted_evidence_unavailable",
        ]),
      )
      .max(5),
    conflict: z
      .object({
        state: z.enum(["none_known", "unresolved", "resolved", "limited"]),
        accessibleRecordIds: z.array(identity).max(64),
        incomplete: z.boolean(),
      })
      .strict(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const knowledgeSummarySchema = knowledgeRecordSchema
  .pick({
    id: true,
    owner: true,
    revision: true,
    title: true,
    kind: true,
    basis: true,
    lifecycle: true,
    visibility: true,
    conflict: true,
    updatedAt: true,
  })
  .extend({
    assertionPreview: z.string().max(1000),
    assertionTruncated: z.boolean(),
    confirmationState: z.enum(["unconfirmed", "confirmed", "revoked"]),
    freshnessState: z.enum(["current", "stale", "unknown"]),
  })
  .strict();
export const knowledgeSearchSchema = z
  .object({
    owner: ownerSchema.optional(),
    q: postgresTextSchema.min(0).max(2000).default(""),
    kind: z.enum(KNOWLEDGE_KINDS).optional(),
    confirmation: z.enum(["unconfirmed", "confirmed", "revoked"]).optional(),
    conflict: z.enum(["unresolved", "resolved"]).optional(),
    freshness: z.enum(["current", "stale", "unknown"]).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const knowledgeSourceCaptureSchema = z
  .object({
    owner: ownerSchema,
    title: postgresTextSchema.min(1).max(256),
    content: postgresTextSchema.min(1).max(32000),
    reportedSourceVersion: postgresTextSchema.min(1).max(256).optional(),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export type KnowledgeRecordDto = z.infer<typeof knowledgeRecordSchema>;
export type KnowledgeWitnessDto = z.infer<typeof knowledgeWitnessSchema>;
export type KnowledgeRecordEvidence = z.infer<
  typeof knowledgeRecordEvidenceSchema
>;
export type KnowledgeSearch = z.infer<typeof knowledgeSearchSchema>;
export type KnowledgeSourceCapture = z.infer<
  typeof knowledgeSourceCaptureSchema
>;

export type KnowledgeSummaryDto = z.infer<typeof knowledgeSummarySchema>;
export type KnowledgeRecordEvidenceSummary = z.infer<
  typeof knowledgeRecordEvidenceSummarySchema
>;

export const knowledgePageInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type KnowledgePageInput = z.infer<typeof knowledgePageInputSchema>;
