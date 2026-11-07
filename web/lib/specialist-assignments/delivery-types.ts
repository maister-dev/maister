import { z } from "zod";

import { assignmentDestinationSchema } from "./types";

import { knowledgeRestrictionsSchema, ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const revision = z.number().int().positive().max(2147483647);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Server-captured terminal witness; historical events without one remain explicitly unenrolled. */
export const assignmentResultWitnessSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: ownerSchema,
    assignmentId: identity,
    inputRevision: revision,
    inputSha256: sha256,
    requesterUserId: identity,
    destination: assignmentDestinationSchema,
    runId: identity,
    resultRevision: revision,
    resultSha256: sha256,
    witnessAlgorithm: z.literal("postgres_jsonb_sha256_v1"),
    schemaRef: postgresTextSchema.min(1).max(512),
    resultSchemaVersion: revision,
    schemaSha256: sha256,
    sourceRestrictions: knowledgeRestrictionsSchema,
  })
  .strict();

export type AssignmentResultWitness = z.infer<
  typeof assignmentResultWitnessSchema
>;
