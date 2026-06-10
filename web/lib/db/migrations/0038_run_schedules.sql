CREATE TABLE IF NOT EXISTS "run_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "cron_expr" text NOT NULL,
  "timezone" text NOT NULL,
  "overlap_policy" text DEFAULT 'skip' NOT NULL,
  "runner_id" text REFERENCES "platform_acp_runners"("id") ON DELETE set null,
  "enabled" boolean DEFAULT true NOT NULL,
  "next_fire_at" timestamp with time zone NOT NULL,
  "queue_one_pending" boolean DEFAULT false NOT NULL,
  "queued_fire_at" timestamp with time zone,
  "last_fired_at" timestamp with time zone,
  "last_fire_outcome" text,
  "last_fire_error" text,
  "last_run_id" text REFERENCES "runs"("id") ON DELETE set null,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_schedules_project_idx" ON "run_schedules" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_schedules_task_idx" ON "run_schedules" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_schedules_due_idx" ON "run_schedules" ("enabled","next_fire_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_schedules_last_run_idx" ON "run_schedules" ("last_run_id");
