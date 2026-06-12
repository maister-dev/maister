CREATE TABLE IF NOT EXISTS "agent_project_links" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"runner_override_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_project_links_agent_project_uq" UNIQUE("agent_id","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"runner_id" text,
	"workspace" text NOT NULL,
	"mode" text NOT NULL,
	"triggers" jsonb NOT NULL,
	"capability_profile" jsonb,
	"risk_tier" text NOT NULL,
	"source_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"quarantined_at" timestamp with time zone,
	"quarantine_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_scope_project_check" CHECK (("agents"."scope" = 'project') = ("agents"."project_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "agent_schedules_scheduler_job_id_scheduler_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "agent_schedules_scheduler_job_id_fkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_schedules_scheduler_job_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_schedules_project_agent_idx";--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "flow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "agent_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "cron_expr" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "next_fire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_source" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_event_id" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_payload" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "triage_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "promotion_mode" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_project_links" ADD CONSTRAINT "agent_project_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_project_links" ADD CONSTRAINT "agent_project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_project_links" ADD CONSTRAINT "agent_project_links_runner_override_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_override_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_project_links_project_idx" ON "agent_project_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_project_idx" ON "agents" USING btree ("project_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_due_cron_idx" ON "agent_schedules" USING btree ("trigger_type","enabled","next_fire_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tokens_agent_idx" ON "project_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_agent_trigger_event_uq" ON "runs" USING btree ("agent_id","trigger_event_id") WHERE "runs"."trigger_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_project_agent_idx" ON "agent_schedules" USING btree ("project_id","agent_id");--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP COLUMN IF EXISTS "scheduler_job_id";--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP COLUMN IF EXISTS "agent_ref";--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP COLUMN IF EXISTS "desired_state";--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_cron_shape_check" CHECK (("agent_schedules"."trigger_type" <> 'cron') OR ("agent_schedules"."cron_expr" IS NOT NULL AND "agent_schedules"."timezone" IS NOT NULL AND "agent_schedules"."next_fire_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_event_shape_check" CHECK (("agent_schedules"."trigger_type" <> 'event') OR ("agent_schedules"."event_match" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_agent_kind_check" CHECK (("project_tokens"."token_kind" = 'agent') = ("project_tokens"."agent_id" IS NOT NULL));