CREATE TABLE IF NOT EXISTS "run_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"session_name" text NOT NULL,
	"runner_id" text,
	"runner_resolution_tier" text,
	"capability_agent" text,
	"runner_snapshot" jsonb,
	"acp_session_id" text,
	"resolution_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_sessions_run_session_uq" UNIQUE("run_id","session_name")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_sessions" ADD CONSTRAINT "run_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_sessions" ADD CONSTRAINT "run_sessions_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_sessions_runner_idx" ON "run_sessions" USING btree ("runner_id");