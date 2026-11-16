import { z } from "zod";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";

export const standInspectionSelectorSchema = z
  .object({
    targetId: z.uuid(),
    componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  })
  .strict();

export const standInspectionAppointmentSchema = standInspectionSelectorSchema
  .extend({
    configRevision: knowledgeRevisionSchema,
    incarnationId: z.uuid(),
  })
  .strict();

export type StandInspectionSelector = z.infer<
  typeof standInspectionSelectorSchema
>;
export type StandInspectionAppointment = z.infer<
  typeof standInspectionAppointmentSchema
>;
