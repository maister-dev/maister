import { z } from "zod";

import { companyConfigurationReferenceSchema } from "./trigger-attempt-types";

import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const userActor = knowledgeActorSchema.extend({
  kind: z.literal("user"),
  id: postgresTextSchema.min(1).max(192),
  runId: z.null(),
  attemptId: z.null(),
});

/** Server-captured launch identity. Current grants and sources remain separate action-time checks. */
export const companyAgentExecutionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: ownerSchema.options[0],
    assignmentRevision: knowledgeRevisionSchema,
    assignment: z
      .object({
        id: identity,
        inputRevision: knowledgeRevisionSchema,
        inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    specialistBinding: companyConfigurationReferenceSchema,
    authority: z
      .object({
        actor: userActor,
        witness: z
          .object({
            kind: z.literal("company_grant"),
            owner: ownerSchema.options[0],
            authorityId: identity,
            revision: knowledgeRevisionSchema,
            action: z.literal("assignments:update"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.owner.companyId === value.authority.witness.owner.companyId,
  );
export type CompanyAgentExecutionSnapshot = z.infer<
  typeof companyAgentExecutionSnapshotSchema
>;
