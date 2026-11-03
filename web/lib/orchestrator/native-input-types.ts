import { z } from "zod";

import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import { knowledgeRestrictionsSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

/** A private execution input, separate from shared task text and from grants. */
export const nativeDelegationInputContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRunId: postgresTextSchema.min(1).max(128),
    sourceGeneration: z.number().int().positive().max(2147483647),
    sourceActor: knowledgeActorSchema,
    sourceRestrictions: knowledgeRestrictionsSchema,
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("agent"),
          id: postgresTextSchema.min(1).max(192),
        })
        .strict(),
      z
        .object({
          kind: z.literal("flow"),
          id: postgresTextSchema.min(1).max(128),
        })
        .strict(),
    ]),
    title: postgresTextSchema.min(1).max(256),
    prompt: postgresTextSchema.min(1).max(32000),
  })
  .strict();

export const nativeDelegationInputSchema = nativeDelegationInputContentSchema
  .extend({
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NativeDelegationInput = z.infer<typeof nativeDelegationInputSchema>;
export type NativeDelegationTarget = NativeDelegationInput["target"];
