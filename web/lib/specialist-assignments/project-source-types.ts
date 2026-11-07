import { z } from "zod";

import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

/** Binds a native comment invocation to the existing source/attempt ledger, without creating an execution ledger. */
export const projectCommentAppointmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("task_comment"),
    attemptId: identity,
    scheduleId: identity,
    runId: identity,
    eventId: z.number().int().positive().safe(),
  })
  .strict();
export type ProjectCommentAppointment = z.infer<
  typeof projectCommentAppointmentSchema
>;

/** Safe persisted refusal tokens keep source diagnostics actionable without copying comment text. */
export const PROJECT_COMMENT_REASON_CODES = [
  "project_comment_appointment_required",
  "project_comment_appointment_unavailable",
  "project_comment_user_author_required",
  "project_comment_source_changed",
  "project_comment_appointment_mismatch",
  "project_comment_input_too_large",
] as const;
