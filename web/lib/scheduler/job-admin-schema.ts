import { z } from "zod";

const jobKindSchema = z.enum([
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
]);

const targetSchema = z.record(z.string(), z.unknown());

export const createSchedulerJobSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    jobKind: jobKindSchema,
    target: targetSchema.optional(),
    cadenceIntervalSeconds: z.number().int().positive(),
    maxFailures: z.number().int().positive().optional(),
    nextRunAt: z.string().datetime().optional(),
    projectId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const updateSchedulerJobSchema = z
  .object({
    target: targetSchema.optional(),
    cadenceIntervalSeconds: z.number().int().positive().optional(),
    maxFailures: z.number().int().positive().optional(),
    nextRunAt: z.string().datetime().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
  });

export type CreateSchedulerJobBody = z.infer<typeof createSchedulerJobSchema>;
export type UpdateSchedulerJobBody = z.infer<typeof updateSchedulerJobSchema>;
