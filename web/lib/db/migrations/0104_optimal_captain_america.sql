CREATE TABLE IF NOT EXISTS "scheduled_task_launch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_launch_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_attempt_number" integer NOT NULL,
	"branch" text NOT NULL,
	"worktree_path" text NOT NULL,
	"request_hash" text NOT NULL,
	"claim_fence" integer NOT NULL,
	"state" text DEFAULT 'Reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_task_launch_attempts_run_id_uq" UNIQUE("run_id"),
	CONSTRAINT "scheduled_task_launch_attempts_task_attempt_check" CHECK ("scheduled_task_launch_attempts"."task_attempt_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_task_launch_events" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_launch_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"claim_fence" integer,
	"error_code" text,
	"message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_task_launches" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text,
	"task_key" text NOT NULL,
	"task_number" integer NOT NULL,
	"task_title" text NOT NULL,
	"created_by_user_id" text,
	"last_actor_user_id" text,
	"scheduled_local_time" text NOT NULL,
	"timezone" text NOT NULL,
	"disambiguation" text,
	"scheduled_for_at" timestamp with time zone NOT NULL,
	"armed_at" timestamp with time zone NOT NULL,
	"launch_request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'Scheduled' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"claim_id" text,
	"claim_fence" integer,
	"claim_expires_at" timestamp with time zone,
	"claim_origin" text,
	"latest_outcome" text,
	"error_code" text,
	"error_message" text,
	"late_by_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_task_launches_project_creator_idempotency_uq" UNIQUE("project_id","created_by_user_id","idempotency_key"),
	CONSTRAINT "scheduled_task_launches_state_shape_check" CHECK ((
        "scheduled_task_launches"."state" = 'Dispatching'
        AND "scheduled_task_launches"."claim_id" IS NOT NULL
        AND "scheduled_task_launches"."claim_fence" IS NOT NULL
        AND "scheduled_task_launches"."claim_expires_at" IS NOT NULL
        AND "scheduled_task_launches"."claim_origin" IS NOT NULL
      ) OR (
        "scheduled_task_launches"."state" <> 'Dispatching'
        AND "scheduled_task_launches"."claim_id" IS NULL
        AND "scheduled_task_launches"."claim_fence" IS NULL
        AND "scheduled_task_launches"."claim_expires_at" IS NULL
        AND "scheduled_task_launches"."claim_origin" IS NULL
      )),
	CONSTRAINT "scheduled_task_launches_attempts_check" CHECK ("scheduled_task_launches"."attempt_count" >= 0 AND "scheduled_task_launches"."attempt_count" <= "scheduled_task_launches"."max_attempts" AND "scheduled_task_launches"."max_attempts" = 3),
	CONSTRAINT "scheduled_task_launches_revision_check" CHECK ("scheduled_task_launches"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "schedules_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_attempt_fence" integer;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "last_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "scheduled_launch_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_schedule_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launch_attempts" ADD CONSTRAINT "scheduled_task_launch_attempts_scheduled_launch_id_scheduled_task_launches_id_fk" FOREIGN KEY ("scheduled_launch_id") REFERENCES "public"."scheduled_task_launches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launch_events" ADD CONSTRAINT "scheduled_task_launch_events_scheduled_launch_id_scheduled_task_launches_id_fk" FOREIGN KEY ("scheduled_launch_id") REFERENCES "public"."scheduled_task_launches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launches" ADD CONSTRAINT "scheduled_task_launches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launches" ADD CONSTRAINT "scheduled_task_launches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launches" ADD CONSTRAINT "scheduled_task_launches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_task_launches" ADD CONSTRAINT "scheduled_task_launches_last_actor_user_id_users_id_fk" FOREIGN KEY ("last_actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_task_launch_attempts_launch_live_uq" ON "scheduled_task_launch_attempts" USING btree ("scheduled_launch_id") WHERE "scheduled_task_launch_attempts"."state" IN ('Reserved', 'Materialized');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_task_launch_attempts_launch_idx" ON "scheduled_task_launch_attempts" USING btree ("scheduled_launch_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_task_launch_events_launch_created_idx" ON "scheduled_task_launch_events" USING btree ("scheduled_launch_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_task_launches_project_idx" ON "scheduled_task_launches" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_task_launches_due_idx" ON "scheduled_task_launches" USING btree ("next_attempt_at","id") WHERE "scheduled_task_launches"."state" IN ('Scheduled', 'RetryWaiting');--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_scheduled_launch_id_scheduled_task_launches_id_fk" FOREIGN KEY ("scheduled_launch_id") REFERENCES "public"."scheduled_task_launches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_schedule_id_agent_schedules_id_fk" FOREIGN KEY ("agent_schedule_id") REFERENCES "public"."agent_schedules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_agent_schedule_idx" ON "runs" USING btree ("agent_schedule_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_scheduled_launch_id_unique" UNIQUE("scheduled_launch_id");