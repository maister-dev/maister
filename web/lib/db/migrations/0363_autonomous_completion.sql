CREATE TABLE "run_autonomous_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"action" text NOT NULL,
	"phase" text NOT NULL,
	"reason" text NOT NULL,
	"project_revision" integer NOT NULL,
	"platform_revision" integer NOT NULL,
	"witness" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_autonomous_decisions_scope_uq" UNIQUE("project_id","run_id","id"),
	CONSTRAINT "run_autonomous_decisions_shape_chk" CHECK (
      "run_autonomous_decisions"."action" IN ('promote','finalize_pr','fail') AND "run_autonomous_decisions"."phase" IN ('refused','claimed','observed')
      AND "run_autonomous_decisions"."project_revision" >= 0 AND "run_autonomous_decisions"."platform_revision" >= 0
      AND jsonb_typeof("run_autonomous_decisions"."witness") = 'object' AND octet_length("run_autonomous_decisions"."witness"::text) <= 16384
      AND length("run_autonomous_decisions"."reason") BETWEEN 1 AND 128
    )
);
--> statement-breakpoint
CREATE TABLE "run_autonomous_reversals" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"reported_by" text NOT NULL,
	"provider_actor_id" text NOT NULL,
	"provider_pr_number" integer NOT NULL,
	"delivered_commit" text NOT NULL,
	"revert_commit" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_autonomous_reversals_commit_uq" UNIQUE("decision_id","revert_commit"),
	CONSTRAINT "run_autonomous_reversals_shape_chk" CHECK (
      "run_autonomous_reversals"."provider_pr_number" > 0 AND
      "run_autonomous_reversals"."delivered_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND
      "run_autonomous_reversals"."revert_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND
      "run_autonomous_reversals"."delivered_commit" <> "run_autonomous_reversals"."revert_commit"
    )
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "completion_git_anchor" jsonb;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "autonomous_completion_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "autonomous_completion_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "autonomous_completion" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "autonomous_completion_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_waits" ADD COLUMN "provider_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "autonomous_completion_grant" jsonb;--> statement-breakpoint
ALTER TABLE "run_autonomous_decisions" ADD CONSTRAINT "run_autonomous_decisions_owner_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_autonomous_reversals" ADD CONSTRAINT "run_autonomous_reversals_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_autonomous_reversals" ADD CONSTRAINT "run_autonomous_reversals_owner_fk" FOREIGN KEY ("project_id","run_id","decision_id") REFERENCES "public"."run_autonomous_decisions"("project_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_autonomous_decisions_history_idx" ON "run_autonomous_decisions" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "run_autonomous_decisions_realized_idx" ON "run_autonomous_decisions" USING btree ("project_id","created_at","id") WHERE "run_autonomous_decisions"."phase" = 'observed';--> statement-breakpoint
CREATE INDEX "run_autonomous_reversals_period_idx" ON "run_autonomous_reversals" USING btree ("project_id","reversed_at","id");--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('knowledge.record_changed', 'specialist.assignment_changed', 'agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.launch_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed', 'run.pr_merged', 'run.wait_registered', 'run.wait_delivery_recorded', 'run.wait_resolved', 'run.wait_closed', 'run.workspace_head_changed', 'run.publication_observed', 'run.ci_observed', 'run.pr_observed', 'run.autonomous_decision'));