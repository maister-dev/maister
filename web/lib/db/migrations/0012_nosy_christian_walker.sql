CREATE TABLE IF NOT EXISTS "capability_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"capability_ref_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"version" text,
	"revision" text,
	"agents" jsonb NOT NULL,
	"enforceability" text DEFAULT 'instructed' NOT NULL,
	"selected_by_default" boolean DEFAULT true NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"material" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_records_project_ref_uq" UNIQUE("project_id","source","kind","capability_ref_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scratch_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"message_id" text,
	"kind" text NOT NULL,
	"label" text,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scratch_capability_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"materialized_path" text NOT NULL,
	"selected_mcp_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adapter_launch" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"downgrade_notes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scratch_capability_profiles_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scratch_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"supervisor_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scratch_messages_run_sequence_uq" UNIQUE("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scratch_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text,
	"initial_prompt" text NOT NULL,
	"plan_mode" text DEFAULT 'off' NOT NULL,
	"linked_task_id" text,
	"linked_issue_url" text,
	"base_branch" text NOT NULL,
	"base_commit" text NOT NULL,
	"target_branch" text,
	"dialog_status" text DEFAULT 'Starting' NOT NULL,
	"supervisor_session_id" text,
	"created_by_user_id" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"error_metadata" jsonb,
	"last_user_message_at" timestamp with time zone,
	"last_agent_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "flow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_kind" text DEFAULT 'flow' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_records" ADD CONSTRAINT "capability_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_attachments" ADD CONSTRAINT "scratch_attachments_run_id_scratch_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scratch_runs"("run_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_attachments" ADD CONSTRAINT "scratch_attachments_message_id_scratch_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."scratch_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_capability_profiles" ADD CONSTRAINT "scratch_capability_profiles_run_id_scratch_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scratch_runs"("run_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_messages" ADD CONSTRAINT "scratch_messages_run_id_scratch_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scratch_runs"("run_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_linked_task_id_tasks_id_fk" FOREIGN KEY ("linked_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "capability_records_project_kind_idx" ON "capability_records" USING btree ("project_id","kind","selectable");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_attachments_run_idx" ON "scratch_attachments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_attachments_message_idx" ON "scratch_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_runs_project_status_idx" ON "scratch_runs" USING btree ("project_id","dialog_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_project_status_kind_idx" ON "runs" USING btree ("project_id","status","run_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_kind_task_idx" ON "runs" USING btree ("run_kind","task_id");