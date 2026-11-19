import { z } from "zod";

import { KNOWLEDGE_KINDS, type KnowledgeAttribution } from "./record-types";

import { postgresTextSchema } from "@/lib/text-schema";
import {
  ownerSchema,
  type KnowledgeAccessRestriction,
} from "@/lib/company/types";

export const knowledgeRevisionSchema = z.number().int().min(1).max(2147483647);

export const knowledgeReferenceSchema = z
  .object({
    kind: z.enum([
      "knowledge",
      "witness",
      "result",
      "operation",
      "verification",
    ]),
    id: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema.optional(),
    version: postgresTextSchema.min(1).max(256).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const knowledgeDraftSchema = z
  .object({
    title: postgresTextSchema.min(1).max(256),
    kind: z.enum(KNOWLEDGE_KINDS),
    assertion: postgresTextSchema.min(1).max(32000),
    basis: z.enum(["observed", "inferred", "unknown"]),
    evidence: z
      .array(
        z
          .object({
            relation: z.enum([
              "supports",
              "contradicts",
              "derived_from",
              "refines",
              "references",
            ]),
            reference: knowledgeReferenceSchema,
          })
          .strict(),
      )
      .max(64),
    missingEvidence: z
      .array(
        z
          .object({
            state: z.enum([
              "absent",
              "stale",
              "missing",
              "inaccessible",
              "unknown",
            ]),
            reason: postgresTextSchema.min(1).max(1000),
          })
          .strict(),
      )
      .max(32),
    limitations: z.array(postgresTextSchema.min(1).max(1000)).max(32),
  })
  .strict();

export const knowledgeDeliveryKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export type KnowledgeDraft = z.infer<typeof knowledgeDraftSchema>;
export type KnowledgeReference = z.infer<typeof knowledgeReferenceSchema>;
export type KnowledgePrincipal =
  | Readonly<{ kind: "user"; userId: string }>
  | Readonly<{ kind: "token"; tokenId: string }>
  | Readonly<{ kind: "librarian_read"; tokenId: string }>
  /** Server-only read inspection; no wire input accepts this principal. */
  | Readonly<{
      kind: "execution";
      runId: string;
      nodeAttemptId: string | null;
    }>;
export type KnowledgeAction =
  | "knowledge:read"
  | "knowledge:propose"
  | "knowledge:review"
  | "knowledge:confirm"
  | "knowledge:manage";

export const nativeKnowledgeOwnerSchema = ownerSchema;

export type CreateKnowledgeProposalInput = Readonly<{
  kind: "knowledge_add" | "knowledge_correct";
  owner: z.infer<typeof ownerSchema>;
  principal: KnowledgePrincipal;
  idempotencyKey: string;
  draft: KnowledgeDraft;
  targetRecordId?: string;
  expectedRecordRevision?: number;
  inheritedRestrictions?: readonly KnowledgeAccessRestriction[];
}>;

export type KnowledgeProposalDto = Readonly<{
  id: string;
  owner: z.infer<typeof ownerSchema>;
  revision: number;
  status: "pending" | "accepted" | "rejected";
  draft: KnowledgeDraft;
  attribution: KnowledgeAttribution;
  acceptedRecordId: string | null;
  acceptedRecordRevision: number | null;
  targetRecordId: string | null;
  expectedRecordRevision: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}>;
