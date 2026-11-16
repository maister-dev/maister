import type { ProjectCoordinatorAdmission } from "./project-flow-launch";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  PreparedSpecialistAssignment,
  SpecialistAssignment,
} from "./types";

import { z } from "zod";

import { assignmentObjectiveInputSchema } from "./types";

import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";
import { knowledgeDeliveryKeySchema } from "@/lib/brain/knowledge-types";

/** Source adapters normalize the original request before resolving mutable provider settings. */
export const specialistIntakeRequestSchema = assignmentObjectiveInputSchema
  .omit({ expectedResult: true })
  .extend({
    owner: ownerSchema,
    specialistBindingId: postgresTextSchema.min(1).max(128),
  })
  .strict();

export const projectSpecialistIntakeRequestSchema =
  specialistIntakeRequestSchema
    .extend({ owner: ownerSchema.options[1] })
    .strict();
export type ProjectSpecialistIntakeRequest = z.infer<
  typeof projectSpecialistIntakeRequestSchema
>;

export const manualSpecialistAssignmentRequestSchema =
  specialistIntakeRequestSchema
    .extend({
      input: specialistIntakeRequestSchema.shape.input.default(""),
      idempotencyKey: knowledgeDeliveryKeySchema,
    })
    .strict();

/** Existing project launch routes derive owner/attachment from their authenticated path. */
export const projectRoutedManualAssignmentRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignment: assignmentObjectiveInputSchema
      .omit({ expectedResult: true })
      .strict(),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

export type SpecialistIntakeRequest = z.infer<
  typeof specialistIntakeRequestSchema
>;
export type PrepareSpecialistIntake = (
  tx: SqlTransaction,
) => Promise<PreparedSpecialistAssignment>;
export type SpecialistIntakeReceipt = Readonly<{
  projectAdmission?: ProjectCoordinatorAdmission;
  receiptId: string;
  assignment: SpecialistAssignment;
  inputRevision: number;
  duplicate: boolean;
  disposition: "created";
}>;
