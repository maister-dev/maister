CREATE TABLE IF NOT EXISTS "flow_runner_remaps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"flow_revision_id" text NOT NULL,
	"step_id" text NOT NULL,
	"source_runner_id" text NOT NULL,
	"mapped_runner_id" text,
	"status" text DEFAULT 'Pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_runner_remaps_project_revision_step_source_uq" UNIQUE("project_id","flow_revision_id","step_id","source_runner_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_acp_runners" (
	"id" text PRIMARY KEY NOT NULL,
	"adapter" text NOT NULL,
	"capability_agent" text NOT NULL,
	"model" text NOT NULL,
	"provider" jsonb NOT NULL,
	"permission_policy" text DEFAULT 'default' NOT NULL,
	"sidecar_id" text,
	"readiness_status" text DEFAULT 'Unknown' NOT NULL,
	"readiness_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_router_sidecars" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"lifecycle" text NOT NULL,
	"command_preset" text,
	"config_path" text,
	"base_url" text,
	"healthcheck_url" text,
	"auth_token_ref" text,
	"readiness_status" text DEFAULT 'Unknown' NOT NULL,
	"readiness_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_runtime_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"default_runner_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_flow_runner_defaults" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"runner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_flow_runner_defaults_project_flow_uq" UNIQUE("project_id","flow_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_executor_override_id_executors_id_fk";
--> statement-breakpoint
ALTER TABLE "flow_revisions" ADD COLUMN "default_runner_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_runner_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_resolution_tier" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "capability_agent" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_executor_id_executors_id_fk";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "executor_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_executor_id_executors_id_fk" FOREIGN KEY ("executor_id") REFERENCES "public"."executors"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_flow_revision_id_flow_revisions_id_fk" FOREIGN KEY ("flow_revision_id") REFERENCES "public"."flow_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_mapped_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("mapped_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_acp_runners" ADD CONSTRAINT "platform_acp_runners_sidecar_id_platform_router_sidecars_id_fk" FOREIGN KEY ("sidecar_id") REFERENCES "public"."platform_router_sidecars"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_runtime_settings" ADD CONSTRAINT "platform_runtime_settings_default_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("default_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_flow_runner_defaults" ADD CONSTRAINT "project_flow_runner_defaults_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_flow_runner_defaults" ADD CONSTRAINT "project_flow_runner_defaults_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_flow_runner_defaults" ADD CONSTRAINT "project_flow_runner_defaults_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runner_remaps_mapped_runner_idx" ON "flow_runner_remaps" USING btree ("mapped_runner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_acp_runners_adapter_enabled_idx" ON "platform_acp_runners" USING btree ("adapter","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_acp_runners_sidecar_idx" ON "platform_acp_runners" USING btree ("sidecar_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_revisions" ADD CONSTRAINT "flow_revisions_default_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("default_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_runner_idx" ON "runs" USING btree ("runner_id");--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "executor_override_id";
