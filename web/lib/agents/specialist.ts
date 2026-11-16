import { z } from "zod";

import { postgresTextSchema } from "@/lib/text-schema";

const declarationEntries = z
  .array(postgresTextSchema.min(1).max(256).regex(/\S/))
  .min(1)
  .max(32)
  .refine(
    (entries) => new Set(entries).size === entries.length,
    "Specialist declaration entries must be distinct",
  );

/** Professional-role metadata describes applicability; it never grants action or source access. */
export const agentSpecialistSchema = z
  .object({
    responsibilities: declarationEntries,
    targetClasses: declarationEntries,
  })
  .strict();
export type AgentSpecialist = z.infer<typeof agentSpecialistSchema>;
