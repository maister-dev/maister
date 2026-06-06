import { z } from "zod";

export const authoredCapabilityKindSchema = z.enum(["rule", "skill", "flow"]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const createAuthoredCapabilitySchema = z
  .object({
    kind: authoredCapabilityKindSchema,
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().min(1),
    body: jsonObjectSchema.optional(),
    manifest: jsonObjectSchema.nullable().optional(),
    schemaVersion: z.number().int().positive().optional(),
  })
  .strict();

export const updateAuthoredDraftSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: jsonObjectSchema.optional(),
    manifest: jsonObjectSchema.nullable().optional(),
    schemaVersion: z.number().int().positive().optional(),
    expectedDraftVersion: z.number().int().positive(),
  })
  .strict();
