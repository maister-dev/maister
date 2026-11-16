import { z } from "zod";

import { specialistIntakeRequestSchema } from "./intake-types";

import { ownerSchema } from "@/lib/company/types";

export const companyWebhookAssignmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignment: specialistIntakeRequestSchema
      .extend({ owner: ownerSchema.options[0] })
      .strict(),
  })
  .strict();
