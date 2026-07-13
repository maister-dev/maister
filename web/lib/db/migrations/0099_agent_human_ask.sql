CREATE TABLE IF NOT EXISTS "task_clarifications" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"source_hitl_request_id" text NOT NULL,
	"origin_run_id" text NOT NULL,
	"origin_agent_id" text NOT NULL,
	"question" text NOT NULL,
	"question_schema" jsonb NOT NULL,
	"retrigger_mode" text NOT NULL,
	"answer" jsonb,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by_hitl_request_id" text,
	"superseded_by_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_clarifications_task_seq_uq" UNIQUE("task_id","seq"),
	CONSTRAINT "task_clarifications_source_hitl_request_uq" UNIQUE("source_hitl_request_id"),
	CONSTRAINT "task_clarifications_seq_positive_check" CHECK ("task_clarifications"."seq" > 0),
	CONSTRAINT "task_clarifications_answer_shape_check" CHECK ((
        "task_clarifications"."answered_at" IS NULL
        AND "task_clarifications"."answer" IS NULL
        AND "task_clarifications"."answered_by_user_id" IS NULL
      ) OR (
        "task_clarifications"."answered_at" IS NOT NULL
        AND "task_clarifications"."answer" IS NOT NULL
        AND "task_clarifications"."answered_by_user_id" IS NOT NULL
      )),
	CONSTRAINT "task_clarifications_supersession_check" CHECK ((
        "task_clarifications"."superseded_at" IS NULL
        AND "task_clarifications"."superseded_by_hitl_request_id" IS NULL
        AND "task_clarifications"."superseded_by_run_id" IS NULL
      ) OR (
        "task_clarifications"."superseded_at" IS NOT NULL
        AND (
          ("task_clarifications"."superseded_by_hitl_request_id" IS NOT NULL AND "task_clarifications"."superseded_by_run_id" IS NULL)
          OR ("task_clarifications"."superseded_by_hitl_request_id" IS NULL AND "task_clarifications"."superseded_by_run_id" IS NOT NULL)
        )
      )),
	CONSTRAINT "task_clarifications_retrigger_mode_check" CHECK ("task_clarifications"."retrigger_mode" IN ('agent', 'triage'))
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "activation_state" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "retrigger_mode" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "superseded_by_hitl_request_id" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "superseded_by_run_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_clarifications" ADD CONSTRAINT "task_clarifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_clarifications_answered_context_idx" ON "task_clarifications" USING btree ("task_id","seq","id") WHERE "task_clarifications"."answered_at" IS NOT NULL AND "task_clarifications"."superseded_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_requests_agent_question_active_idx" ON "hitl_requests" USING btree ("task_id","created_at") WHERE "hitl_requests"."kind" = 'agent_question' AND "hitl_requests"."activation_state" = 'active' AND "hitl_requests"."responded_at" IS NULL AND "hitl_requests"."superseded_at" IS NULL;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_answered', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.escalated', 'gate.failed'));--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_shape_check" CHECK ((
        "hitl_requests"."kind" = 'agent_question'
        AND "hitl_requests"."task_id" IS NOT NULL
        AND "hitl_requests"."activation_state" IS NOT NULL
        AND "hitl_requests"."retrigger_mode" IS NOT NULL
        AND "hitl_requests"."schema" IS NOT NULL
      ) OR (
        "hitl_requests"."kind" <> 'agent_question'
        AND "hitl_requests"."task_id" IS NULL
        AND "hitl_requests"."activation_state" IS NULL
        AND "hitl_requests"."retrigger_mode" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_supersession_check" CHECK ((
        "hitl_requests"."kind" <> 'agent_question'
        AND "hitl_requests"."superseded_at" IS NULL
        AND "hitl_requests"."superseded_by_hitl_request_id" IS NULL
        AND "hitl_requests"."superseded_by_run_id" IS NULL
      ) OR (
        "hitl_requests"."kind" = 'agent_question'
        AND (
          (
            "hitl_requests"."superseded_at" IS NULL
            AND "hitl_requests"."superseded_by_hitl_request_id" IS NULL
            AND "hitl_requests"."superseded_by_run_id" IS NULL
          ) OR (
            "hitl_requests"."superseded_at" IS NOT NULL
            AND (
              ("hitl_requests"."superseded_by_hitl_request_id" IS NOT NULL AND "hitl_requests"."superseded_by_run_id" IS NULL)
              OR ("hitl_requests"."superseded_by_hitl_request_id" IS NULL AND "hitl_requests"."superseded_by_run_id" IS NOT NULL)
            )
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_activation_state_check" CHECK ("hitl_requests"."activation_state" IS NULL OR "hitl_requests"."activation_state" IN ('pending_termination', 'active', 'failed'));--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD CONSTRAINT "hitl_requests_agent_question_retrigger_mode_check" CHECK ("hitl_requests"."retrigger_mode" IS NULL OR "hitl_requests"."retrigger_mode" IN ('agent', 'triage'));