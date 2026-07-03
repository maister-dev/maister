ALTER TABLE "task_activity" DROP CONSTRAINT IF EXISTS "task_activity_event_kind_check";--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded'));--> statement-breakpoint
ALTER TABLE "inbox_items" DROP CONSTRAINT IF EXISTS "inbox_items_event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"run_id" text NOT NULL,
	"variant_key" text NOT NULL,
	"replicate_ordinal" integer NOT NULL,
	"launch_reason" text NOT NULL,
	"base_commit" text NOT NULL,
	"diff_snapshot" text,
	"diff_snapshot_truncated" boolean DEFAULT false NOT NULL,
	"diff_snapshot_bytes" integer,
	"diff_snapshot_captured_at" timestamp with time zone,
	"diff_files_summary" jsonb,
	"materialization_delta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_runs_run_uq" UNIQUE("run_id"),
	CONSTRAINT "experiment_runs_variant_replicate_uq" UNIQUE("experiment_id","variant_key","replicate_ordinal"),
	CONSTRAINT "experiment_runs_launch_reason_check" CHECK ("experiment_runs"."launch_reason" in ('initial', 'manual_relaunch', 'budget_restart')),
	CONSTRAINT "experiment_runs_replicate_positive_check" CHECK ("experiment_runs"."replicate_ordinal" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"base_branch" text NOT NULL,
	"base_commit" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"variants" jsonb NOT NULL,
	"rubric" jsonb NOT NULL,
	"verdict" jsonb,
	"created_by_user_id" text,
	"concluded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone,
	"comparable_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "experiments_status_check" CHECK ("experiments"."status" in ('draft', 'running', 'comparable', 'concluded', 'abandoned'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiment_runs" ADD CONSTRAINT "experiment_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiments" ADD CONSTRAINT "experiments_concluded_by_user_id_users_id_fk" FOREIGN KEY ("concluded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_runs_experiment_idx" ON "experiment_runs" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_project_status_idx" ON "experiments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_task_idx" ON "experiments" USING btree ("task_id");
