CREATE TABLE IF NOT EXISTS "scheduler_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text REFERENCES "projects"("id") ON DELETE cascade,
  "job_kind" text NOT NULL,
  "target" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "cadence_interval_seconds" integer NOT NULL,
  "next_run_at" timestamp with time zone NOT NULL,
  "last_fired_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "max_failures" integer DEFAULT 3 NOT NULL,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduler_jobs_due_idx" ON "scheduler_jobs" ("disabled_at","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduler_jobs_kind_due_idx" ON "scheduler_jobs" ("job_kind","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduler_jobs_project_kind_idx" ON "scheduler_jobs" ("project_id","job_kind");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduler_job_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL REFERENCES "scheduler_jobs"("id") ON DELETE cascade,
  "job_kind" text NOT NULL,
  "status" text DEFAULT 'Claimed' NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduler_job_runs_job_idx" ON "scheduler_job_runs" ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduler_job_runs_lease_idx" ON "scheduler_job_runs" ("status","lease_expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text REFERENCES "projects"("id") ON DELETE cascade,
  "scheduler_job_id" text NOT NULL REFERENCES "scheduler_jobs"("id") ON DELETE cascade,
  "agent_ref" text NOT NULL,
  "trigger_type" text NOT NULL,
  "desired_state" text,
  "event_match" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_project_agent_idx" ON "agent_schedules" ("project_id","agent_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_scheduler_job_idx" ON "agent_schedules" ("scheduler_job_id");
