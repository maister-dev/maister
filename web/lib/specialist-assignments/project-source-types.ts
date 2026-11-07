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

export const projectCronAppointmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("cron"),
    attemptId: identity,
    scheduleId: identity,
    runId: identity,
  })
  .strict();
export type ProjectCronAppointment = z.infer<
  typeof projectCronAppointmentSchema
>;
export const projectEventAppointmentSchema = projectCommentAppointmentSchema
  .extend({ kind: z.literal("event") })
  .strict();
export type ProjectEventAppointment = z.infer<
  typeof projectEventAppointmentSchema
>;
export const PROJECT_EVENT_REASON_CODES = [
  "project_event_review_required",
  "project_event_appointment_unavailable",
  "project_event_source_changed",
  "project_event_sharing_required",
  "project_event_source_unclassified",
  "project_event_chain_unclassified",
  "project_event_appointment_required",
  "project_event_appointment_mismatch",
  "project_event_source_kinds_invalid",
] as const;
export const projectSourceAppointmentSchema = z.union([
  projectCommentAppointmentSchema,
  projectCronAppointmentSchema,
  projectEventAppointmentSchema,
]);
export type ProjectSourceAppointment = z.infer<
  typeof projectSourceAppointmentSchema
>;

export const PROJECT_CRON_REASON_CODES = [
  "project_source_review_required",
  "project_source_review_changed",
  "project_cron_appointment_required",
  "project_cron_appointment_unavailable",
  "project_cron_source_changed",
  "project_cron_appointment_mismatch",
  "project_scheduled_request_missing",
] as const;

/** Safe persisted refusal tokens keep source diagnostics actionable without copying comment text. */
export const PROJECT_COMMENT_REASON_CODES = [
  "project_comment_appointment_required",
  "project_comment_appointment_unavailable",
  "project_comment_user_author_required",
  "project_comment_source_changed",
  "project_comment_appointment_mismatch",
  "project_comment_input_too_large",
] as const;
