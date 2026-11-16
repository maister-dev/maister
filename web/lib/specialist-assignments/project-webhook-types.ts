import { z } from "zod";

import { specialistIntakeRequestSchema } from "./intake-types";

import { ownerSchema } from "@/lib/company/types";

export const projectWebhookAssignmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignment: specialistIntakeRequestSchema
      .extend({ owner: ownerSchema.options[1] })
      .strict(),
  })
  .strict();
