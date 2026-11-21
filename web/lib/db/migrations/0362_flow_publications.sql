ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_publication_owner_uq" UNIQUE("project_id","run_id","id");--> statement-breakpoint
CREATE TABLE "run_publication_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_revision" text NOT NULL,
	"head_sha" text NOT NULL,
	"fact" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_publication_observations_receipt_uq" UNIQUE("publication_id","kind","source_revision"),
	CONSTRAINT "run_publication_observations_shape_check" CHECK ((
      "run_publication_observations"."kind" IN ('ci','pr','ref') AND "run_publication_observations"."head_sha" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
      AND length("run_publication_observations"."source_revision") BETWEEN 1 AND 256 AND jsonb_typeof("run_publication_observations"."fact") = 'object'
      AND "run_publication_observations"."fact"->'schemaVersion' = '1'::jsonb AND octet_length("run_publication_observations"."fact"::text) <= 32768
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "run_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"flow_revision" text NOT NULL,
	"assignment_id" text,
	"remote_name" text NOT NULL,
	"repo_identity" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"source_head" text NOT NULL,
	"expected_remote_head" text,
	"observed_head" text,
	"pr_mode" text NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"phase" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_at" timestamp with time zone,
	CONSTRAINT "run_publications_observation_owner_uq" UNIQUE("project_id","run_id","id"),
	CONSTRAINT "run_publications_operation_uq" UNIQUE("run_id","node_attempt_id","operation_key"),
	CONSTRAINT "run_publications_generation_uq" UNIQUE("run_id","generation"),
	CONSTRAINT "run_publications_shape_check" CHECK ((
      "run_publications"."generation" >= 1 AND length("run_publications"."operation_key") BETWEEN 1 AND 256 AND
      "run_publications"."source_head" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND
      ("run_publications"."expected_remote_head" IS NULL OR "run_publications"."expected_remote_head" ~ '^([a-f0-9]{40}|[a-f0-9]{64})$') AND
      "run_publications"."pr_mode" IN ('none','draft','ready') AND "run_publications"."phase" IN ('claimed','observed','refused','uncertain') AND
      "run_publications"."head_ref" LIKE 'refs/heads/%' AND "run_publications"."base_ref" LIKE 'refs/heads/%' AND
      ("run_publications"."pr_number" IS NULL) = ("run_publications"."pr_url" IS NULL) AND
      ("run_publications"."pr_number" IS NULL OR "run_publications"."pr_number" > 0 AND "run_publications"."pr_mode" <> 'none') AND
      (("run_publications"."phase" = 'observed' AND "run_publications"."observed_at" IS NOT NULL AND "run_publications"."observed_head" = "run_publications"."source_head" AND ("run_publications"."pr_mode" = 'none' OR "run_publications"."pr_number" IS NOT NULL))
        OR ("run_publications"."phase" <> 'observed' AND "run_publications"."observed_at" IS NULL AND "run_publications"."observed_head" IS NULL))
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "run_waits" DROP CONSTRAINT "run_waits_state_check";--> statement-breakpoint
ALTER TABLE "run_waits" DROP CONSTRAINT "run_waits_condition_check";--> statement-breakpoint
ALTER TABLE "run_waits" DROP CONSTRAINT "run_waits_deadline_check";--> statement-breakpoint
ALTER TABLE "run_waits" DROP CONSTRAINT "run_waits_result_check";--> statement-breakpoint
ALTER TABLE "run_waits" ALTER COLUMN "node_attempt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_waits" ADD COLUMN "publication_id" text;--> statement-breakpoint
ALTER TABLE "run_waits" ADD COLUMN "provider_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_waits" ADD COLUMN "reserved_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "flow_publication_grant" jsonb;--> statement-breakpoint
ALTER TABLE "run_publication_observations" ADD CONSTRAINT "run_publication_observations_owner_fk" FOREIGN KEY ("project_id","run_id","publication_id") REFERENCES "public"."run_publications"("project_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_publications" ADD CONSTRAINT "run_publications_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_publications" ADD CONSTRAINT "run_publications_run_owner_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_publications" ADD CONSTRAINT "run_publications_node_owner_fk" FOREIGN KEY ("run_id","node_attempt_id") REFERENCES "public"."node_attempts"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_publications" ADD CONSTRAINT "run_publications_workspace_owner_fk" FOREIGN KEY ("project_id","run_id","workspace_id") REFERENCES "public"."workspaces"("project_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_publication_observations_latest_idx" ON "run_publication_observations" USING btree ("publication_id","kind","observed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_publication_owner_fk" FOREIGN KEY ("project_id","run_id","publication_id") REFERENCES "public"."run_publications"("project_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_waits_reserved_due_idx" ON "run_waits" USING btree ("reserved_until","id") WHERE state = 'reserved';--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('knowledge.record_changed', 'specialist.assignment_changed', 'agent.activity_changed', 'agent.incident_changed', 'task.qualification_changed', 'task.launch_changed', 'task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_requested', 'task.clarification_answered', 'task.clarification_cancelled', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed', 'run.operational_attention_acknowledged', 'run.operational_cleanup_changed', 'run.pr_merged', 'run.wait_registered', 'run.wait_delivery_recorded', 'run.wait_resolved', 'run.wait_closed', 'run.workspace_head_changed', 'run.publication_observed', 'run.ci_observed', 'run.pr_observed'));--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.release', 'workspace.observe_head', 'workspace.publication', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_state_check" CHECK (
      "run_waits"."owner_kind" = 'flow' AND "run_waits"."state" IN ('reserved','parking','open','resolved','closed')
      AND "run_waits"."version" >= 0
      AND ("run_waits"."state" = 'closed') = ("run_waits"."closed_at" IS NOT NULL)
      AND ("run_waits"."node_attempt_id" IS NOT NULL OR ("run_waits"."state" IN ('reserved','closed') AND "run_waits"."publication_id" IS NOT NULL AND "run_waits"."reserved_until" IS NOT NULL))
      AND ("run_waits"."state" <> 'reserved' OR ("run_waits"."node_attempt_id" IS NULL AND "run_waits"."reserved_until" IS NOT NULL))
    );--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_condition_check" CHECK (
      ("run_waits"."condition_kind" IN ('timer','comment','run','signal','ci','pr')
      AND ("run_waits"."condition_kind" IN ('ci','pr')) = ("run_waits"."publication_id" IS NOT NULL)
      AND jsonb_typeof("run_waits"."condition") = 'object'
      AND "run_waits"."condition"->'schemaVersion' = '1'::jsonb
      AND "run_waits"."condition"->>'kind' = "run_waits"."condition_kind"
      AND pg_column_size("run_waits"."condition") <= 32768
      AND ("run_waits"."binding_head_sha" IS NULL OR "run_waits"."binding_head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')) IS TRUE
    );--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_deadline_check" CHECK (
      (("run_waits"."state" IN ('reserved','parking','closed') AND "run_waits"."opened_at" IS NULL AND
        "run_waits"."next_due_at" IS NULL AND "run_waits"."deadline_at" IS NULL AND "run_waits"."absolute_cap_at" IS NULL) OR
       ("run_waits"."opened_at" IS NOT NULL AND "run_waits"."next_due_at" IS NOT NULL
        AND "run_waits"."opened_at" <= "run_waits"."deadline_at" AND "run_waits"."deadline_at" <= "run_waits"."absolute_cap_at"
        AND ("run_waits"."condition_kind" = 'timer') = ("run_waits"."timer_at" IS NOT NULL)
        AND "run_waits"."next_due_at" = least("run_waits"."timer_at", "run_waits"."deadline_at"))) IS TRUE
    );--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_result_check" CHECK (
      (("run_waits"."state" = 'resolved' AND
          "run_waits"."resolved_at" IS NOT NULL AND "run_waits"."resolved_at" >= "run_waits"."opened_at" AND
          jsonb_typeof("run_waits"."result") = 'object' AND "run_waits"."result"->'schemaVersion' = '1'::jsonb AND
          jsonb_typeof("run_waits"."result"->'outcome') = 'string' AND
          "run_waits"."result"->>'source' IN ('timer','comment','run','signal','operator','head','provider') AND
          jsonb_typeof("run_waits"."result"->'sourceId') = 'string' AND
          pg_column_size("run_waits"."result") <= 65536 AND
          "run_waits"."result_digest" ~ '^[0-9a-f]{64}$' AND "run_waits"."queued_at" IS NOT NULL AND
          "run_waits"."resume_state" IN ('queued','admitted','applied','invalidated') AND
          ("run_waits"."resume_state" NOT IN ('admitted','applied') OR "run_waits"."resume_assignment_id" IS NOT NULL))
        OR ("run_waits"."state" <> 'resolved' AND "run_waits"."resolved_at" IS NULL AND
          "run_waits"."result" IS NULL AND "run_waits"."result_digest" IS NULL AND "run_waits"."queued_at" IS NULL AND
          "run_waits"."resume_state" IS NULL AND "run_waits"."resume_assignment_id" IS NULL)) IS TRUE
    );