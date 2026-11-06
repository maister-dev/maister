import { z } from "zod";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";
import { companyConfigurationReferenceSchema } from "./trigger-attempt-types";

/** Flow captures add the reviewed coordinator witness without rewriting version-1 standalone provenance. */
export const companyFlowExecutionSnapshotSchema = z
  .object({
    ...companyAgentExecutionSnapshotSchema.shape,
    schemaVersion: z.literal(2),
    executionKind: z.literal("flow"),
    coordinatorFlowBinding: companyConfigurationReferenceSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.owner.companyId === value.authority.witness.owner.companyId,
  );

/** Historical captures identify the launch; current permissions remain an action-time decision. */
export const companyExecutionSnapshotSchema = z.discriminatedUnion(
  "schemaVersion",
  [companyAgentExecutionSnapshotSchema, companyFlowExecutionSnapshotSchema],
);

export type CompanyFlowExecutionSnapshot = z.infer<
  typeof companyFlowExecutionSnapshotSchema
>;
export type CompanyExecutionSnapshot = z.infer<
  typeof companyExecutionSnapshotSchema
>;
