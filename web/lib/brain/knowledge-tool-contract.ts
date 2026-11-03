import { z } from "zod";

import {
  knowledgePageInputSchema,
  knowledgeSearchSchema,
  knowledgeSourceCaptureSchema,
} from "./knowledge-read-types";
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
} as const;
