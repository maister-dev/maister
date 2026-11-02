import { z } from "zod";

import { formSchemaSchema } from "@/lib/config.schema";

/** The Human-ask HTTP body and generated MCP input share this form grammar. */
export const humanAskBodySchema = z
  .object({
    question: z.string().min(1).max(10_000),
    schema: formSchemaSchema
      .extend({ schemaVersion: z.literal(1) })
      .describe(
        "MAIster form schema: {schemaVersion:1,fields:[{name,type,required?,label?,options?}]}. This is not JSON Schema. For open questions use string fields with optional suggested options. Nested object fields use fields; arrays use items.",
      ),
    reTriggerMode: z.enum(["agent", "triage"]).default("agent"),
  })
  .strict();

export const askHumanToolInputSchema = humanAskBodySchema.extend({
  slug: z.string(),
  taskId: z.string(),
});

export type HumanAskBody = z.infer<typeof humanAskBodySchema>;
