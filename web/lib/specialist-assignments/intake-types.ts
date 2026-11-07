import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  PreparedSpecialistAssignment,
  SpecialistAssignment,
} from "./types";

import { z } from "zod";

import { assignmentObjectiveInputSchema } from "./types";

import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

/** Source adapters normalize the original request before resolving mutable provider settings. */
export const specialistIntakeRequestSchema = assignmentObjectiveInputSchema
  .omit({ expectedResult: true })
  .extend({
    owner: ownerSchema,
    specialistBindingId: postgresTextSchema.min(1).max(128),
  })
  .strict();

export type SpecialistIntakeRequest = z.infer<
  typeof specialistIntakeRequestSchema
>;
export type PrepareSpecialistIntake = (
  tx: SqlTransaction,
) => Promise<PreparedSpecialistAssignment>;
export type SpecialistIntakeReceipt = Readonly<{
  receiptId: string;
  assignment: SpecialistAssignment;
  inputRevision: number;
  duplicate: boolean;
  disposition: "created";
}>;
