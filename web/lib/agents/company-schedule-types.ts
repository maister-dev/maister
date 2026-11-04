import { z } from "zod";

import { knowledgeDeliveryKeySchema } from "@/lib/brain/knowledge-types";
import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

/** Scheduled request text is independent from standing role configuration and invocation authority. */
export const companyCronScheduleInputSchema = z
  .object({
    owner: ownerSchema.options[0],
    specialistBindingId: identity,
    coordinatorFlowBindingId: identity.nullable().default(null),
    cronExpr: postgresTextSchema.min(1).max(128),
    timezone: postgresTextSchema.min(1).max(64),
    requestAtLaunch: postgresTextSchema.nullable().default(null),
    enabled: z.boolean().default(false),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
export type CompanyCronScheduleInput = z.input<
  typeof companyCronScheduleInputSchema
>;
export type CompanyCronScheduleReceipt = Readonly<{
  scheduleId: string;
  owner: Readonly<{ kind: "company"; companyId: string }>;
  configRevision: number;
  duplicate: boolean;
}>;
