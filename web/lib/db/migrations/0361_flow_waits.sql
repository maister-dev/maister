ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_wait_owner_uq" UNIQUE("run_id","id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_wait_owner_uq" UNIQUE("project_id","id");--> statement-breakpoint
CREATE TABLE "run_wait_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"wait_id" text NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"expected_version" integer NOT NULL,
	"resulting_version" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_wait_actions_intent_uq" UNIQUE("wait_id","user_id","idempotency_key"),
	CONSTRAINT "run_wait_actions_shape_check" CHECK (
      "run_wait_actions"."action" IN ('deliver_signal','resolve_now','extend','cancel') AND
      length("run_wait_actions"."idempotency_key") BETWEEN 1 AND 128 AND
      length("run_wait_actions"."reason") BETWEEN 1 AND 1024 AND "run_wait_actions"."payload_digest" ~ '^[0-9a-f]{64}$' AND
      "run_wait_actions"."expected_version" >= 0 AND "run_wait_actions"."resulting_version" >= "run_wait_actions"."expected_version"
    )
);
--> statement-breakpoint
CREATE TABLE "run_wait_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"wait_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"body" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone NOT NULL,
	"application" text NOT NULL,
	CONSTRAINT "run_wait_deliveries_receipt_uq" UNIQUE("wait_id","source_kind","source_id","idempotency_key"),
	CONSTRAINT "run_wait_deliveries_shape_check" CHECK (
      "run_wait_deliveries"."source_kind" IN ('project_token','operator') AND
      length("run_wait_deliveries"."idempotency_key") BETWEEN 1 AND 128 AND "run_wait_deliveries"."payload_digest" ~ '^[0-9a-f]{64}$' AND
      pg_column_size("run_wait_deliveries"."body") <= 65536 AND
      (("run_wait_deliveries"."disposition" = 'accepted' AND "run_wait_deliveries"."reason" IS NULL AND "run_wait_deliveries"."application" IN ('pending','applied','not_applied'))
       OR ("run_wait_deliveries"."disposition" IN ('stale','rejected') AND "run_wait_deliveries"."reason" IS NOT NULL AND "run_wait_deliveries"."application" = 'not_applied'))
    )
);
--> statement-breakpoint
CREATE TABLE "run_waits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"occurrence_key" text NOT NULL,
	"node_attempt_id" text NOT NULL,
	"flow_revision" text NOT NULL,
	"condition_kind" text NOT NULL,
	"condition" jsonb NOT NULL,
	"source_target_id" text,
	"binding_head_sha" text,
	"registration_snapshot" text,
	"state" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"timer_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"absolute_cap_at" timestamp with time zone,
	"deadline_retry_at" timestamp with time zone,
	"result" jsonb,
	"result_digest" text,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"resume_state" text,
	"resume_assignment_id" text,
	CONSTRAINT "run_waits_attempt_unique" UNIQUE("node_attempt_id"),
	CONSTRAINT "run_waits_occurrence_unique" UNIQUE("run_id","owner_kind","occurrence_key"),
	CONSTRAINT "run_waits_state_check" CHECK (
      "run_waits"."owner_kind" = 'flow' AND "run_waits"."state" IN ('parking','open','resolved','closed')
      AND "run_waits"."version" >= 0
      AND ("run_waits"."state" = 'closed') = ("run_waits"."closed_at" IS NOT NULL)
    ),
	CONSTRAINT "run_waits_condition_check" CHECK (
      ("run_waits"."condition_kind" IN ('timer','comment','run','signal')
      AND jsonb_typeof("run_waits"."condition") = 'object'
      AND "run_waits"."condition"->'schemaVersion' = '1'::jsonb
      AND "run_waits"."condition"->>'kind' = "run_waits"."condition_kind"
      AND pg_column_size("run_waits"."condition") <= 32768
      AND ("run_waits"."binding_head_sha" IS NULL OR "run_waits"."binding_head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')) IS TRUE
    ),
	CONSTRAINT "run_waits_deadline_check" CHECK (
      (("run_waits"."state" IN ('parking','closed') AND "run_waits"."opened_at" IS NULL AND
        "run_waits"."next_due_at" IS NULL AND "run_waits"."deadline_at" IS NULL AND "run_waits"."absolute_cap_at" IS NULL) OR
       ("run_waits"."opened_at" IS NOT NULL AND "run_waits"."next_due_at" IS NOT NULL
        AND "run_waits"."opened_at" <= "run_waits"."deadline_at" AND "run_waits"."deadline_at" <= "run_waits"."absolute_cap_at"
        AND ("run_waits"."condition_kind" = 'timer') = ("run_waits"."timer_at" IS NOT NULL)
        AND "run_waits"."next_due_at" = least("run_waits"."timer_at", "run_waits"."deadline_at"))) IS TRUE
    ),
	CONSTRAINT "run_waits_result_check" CHECK (
      (("run_waits"."state" = 'resolved' AND
          "run_waits"."resolved_at" IS NOT NULL AND "run_waits"."resolved_at" >= "run_waits"."opened_at" AND
          jsonb_typeof("run_waits"."result") = 'object' AND "run_waits"."result"->'schemaVersion' = '1'::jsonb AND
          jsonb_typeof("run_waits"."result"->'outcome') = 'string' AND
          "run_waits"."result"->>'source' IN ('timer','comment','run','signal','operator','head') AND
          jsonb_typeof("run_waits"."result"->'sourceId') = 'string' AND
          pg_column_size("run_waits"."result") <= 65536 AND
          "run_waits"."result_digest" ~ '^[0-9a-f]{64}$' AND "run_waits"."queued_at" IS NOT NULL AND
          "run_waits"."resume_state" IN ('queued','admitted','applied','invalidated') AND
          ("run_waits"."resume_state" NOT IN ('admitted','applied') OR "run_waits"."resume_assignment_id" IS NOT NULL))
        OR ("run_waits"."state" <> 'resolved' AND "run_waits"."resolved_at" IS NULL AND
          "run_waits"."result" IS NULL AND "run_waits"."result_digest" IS NULL AND "run_waits"."queued_at" IS NULL AND
          "run_waits"."resume_state" IS NULL AND "run_waits"."resume_assignment_id" IS NULL)) IS TRUE
    )
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "run_wait_actions" ADD CONSTRAINT "run_wait_actions_wait_id_run_waits_id_fk" FOREIGN KEY ("wait_id") REFERENCES "public"."run_waits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_wait_deliveries" ADD CONSTRAINT "run_wait_deliveries_wait_id_run_waits_id_fk" FOREIGN KEY ("wait_id") REFERENCES "public"."run_waits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_resume_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("resume_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_owner_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_owner_attempt_fk" FOREIGN KEY ("run_id","node_attempt_id") REFERENCES "public"."node_attempts"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_wait_deliveries_pending_idx" ON "run_wait_deliveries" USING btree ("wait_id","received_at","id") WHERE application = 'pending';--> statement-breakpoint
CREATE INDEX "run_waits_due_idx" ON "run_waits" USING btree (greatest("next_due_at", "deadline_retry_at"),"id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "run_waits_open_source_idx" ON "run_waits" USING btree ("project_id","condition_kind","source_target_id") WHERE state = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "run_waits_resume_in_progress_uq" ON "run_waits" USING btree ("run_id") WHERE resume_state IN ('queued', 'admitted');--> statement-breakpoint
CREATE INDEX "domain_events_wait_comment_idx" ON "domain_events" USING btree ("project_id","task_id","occurred_at","id") WHERE "domain_events"."kind" = 'task.comment_added';--> statement-breakpoint
CREATE INDEX "domain_events_wait_run_settle_idx" ON "domain_events" USING btree ("project_id","run_id","occurred_at","id") WHERE "domain_events"."kind" IN ('run.done','run.failed','run.review','run.review_opened','run.crashed','run.abandoned');--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('knowledge.record_changed', 'specialist.assignment_changed', 'agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.launch_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed', 'run.pr_merged', 'run.wait_registered', 'run.wait_delivery_recorded', 'run.wait_resolved', 'run.wait_closed'));--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.release', 'workspace.observe_head', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));