CREATE TABLE IF NOT EXISTS "run_sync_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"strategy" text NOT NULL,
	"mode" text NOT NULL,
	"phase" text DEFAULT 'starting' NOT NULL,
	"target_ref" text,
	"target_sha" text,
	"head_sha_before" text,
	"head_sha_after" text,
	"remote_sha_before" text,
	"conflicted_files" jsonb,
	"runner_id" text,
	"session_name" text,
	"agent_running_since" timestamp with time zone,
	"auto_finalize" boolean DEFAULT false NOT NULL,
	"pushed" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"actor_type" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_sync_attempts_run_attempt_uq" UNIQUE("run_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sync_strategy_default" text DEFAULT 'rebase' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sync_runner_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_sync_attempts" ADD CONSTRAINT "run_sync_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_sync_attempts" ADD CONSTRAINT "run_sync_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_sync_attempts_run_idx" ON "run_sync_attempts" USING btree ("run_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_sync_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("sync_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
