ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_event_kind_check";--> statement-breakpoint
ALTER TABLE "task_activity" DROP CONSTRAINT "task_activity_event_kind_check";--> statement-breakpoint
ALTER TABLE "task_clarifications" DROP CONSTRAINT "task_clarifications_supersession_check";--> statement-breakpoint
ALTER TABLE "task_clarifications" DROP CONSTRAINT "task_clarifications_retrigger_mode_check";--> statement-breakpoint
ALTER TABLE "task_clarifications" ALTER COLUMN "source_hitl_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ALTER COLUMN "origin_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ALTER COLUMN "origin_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ALTER COLUMN "question_schema" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "origin_kind" text DEFAULT 'agent_run' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "requester_user_id" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "answer_format" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
UPDATE "task_clarifications" SET "status" = CASE
  WHEN "superseded_at" IS NOT NULL THEN 'superseded'
  WHEN "answered_at" IS NOT NULL THEN 'answered'
  ELSE 'open'
END;--> statement-breakpoint
ALTER TABLE "task_clarifications" ALTER COLUMN "origin_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "superseded_by_clarification_id" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD COLUMN "requested_via_operation_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_source_message_id_librarian_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_requested_via_operation_uq" UNIQUE("requested_via_operation_id");--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed'));--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'clarification_requested'));--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'evaluation_decided', 'agent_summon_suppressed', 'statement_accepted', 'clarification_requested', 'clarification_answered', 'clarification_cancelled'));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_origin_kind_check" CHECK ("task_clarifications"."origin_kind" IN ('agent_run', 'user'));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_origin_shape_check" CHECK ((
        "task_clarifications"."origin_kind" = 'agent_run'
        AND "task_clarifications"."source_hitl_request_id" IS NOT NULL
        AND "task_clarifications"."origin_run_id" IS NOT NULL
        AND "task_clarifications"."origin_agent_id" IS NOT NULL
        AND "task_clarifications"."question_schema" IS NOT NULL
        AND "task_clarifications"."retrigger_mode" <> 'none'
      ) OR (
        "task_clarifications"."origin_kind" = 'user'
        AND "task_clarifications"."source_hitl_request_id" IS NULL
        AND "task_clarifications"."origin_run_id" IS NULL
        AND "task_clarifications"."origin_agent_id" IS NULL
        AND "task_clarifications"."requester_user_id" IS NOT NULL
        AND "task_clarifications"."recipient_user_id" IS NOT NULL
        AND "task_clarifications"."reason" IS NOT NULL
        AND "task_clarifications"."answer_format" IS NOT NULL
        AND "task_clarifications"."retrigger_mode" = 'none'
      ));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_answer_format_check" CHECK ("task_clarifications"."answer_format" IS NULL OR "task_clarifications"."answer_format" IN ('text', 'choice', 'yes_no'));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_status_check" CHECK ("task_clarifications"."status" IN ('open', 'answered', 'cancelled', 'superseded'));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_status_shape_check" CHECK (("task_clarifications"."status" <> 'answered' OR "task_clarifications"."answered_at" IS NOT NULL)
        AND ("task_clarifications"."status" NOT IN ('open', 'cancelled') OR "task_clarifications"."answered_at" IS NULL)
        AND ("task_clarifications"."status" <> 'cancelled' OR "task_clarifications"."cancel_reason" IS NOT NULL)
        AND (("task_clarifications"."status" = 'superseded') = ("task_clarifications"."superseded_at" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_supersession_check" CHECK ((
        "task_clarifications"."superseded_at" IS NULL
        AND num_nonnulls("task_clarifications"."superseded_by_hitl_request_id", "task_clarifications"."superseded_by_run_id", "task_clarifications"."superseded_by_clarification_id") = 0
      ) OR (
        "task_clarifications"."superseded_at" IS NOT NULL
        AND num_nonnulls("task_clarifications"."superseded_by_hitl_request_id", "task_clarifications"."superseded_by_run_id", "task_clarifications"."superseded_by_clarification_id") = 1
      ));--> statement-breakpoint
ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_retrigger_mode_check" CHECK ("task_clarifications"."retrigger_mode" IN ('agent', 'triage', 'none'));
