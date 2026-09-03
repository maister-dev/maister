CREATE TABLE IF NOT EXISTS "execution_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"state" text NOT NULL,
	"placement_reason" text NOT NULL,
	"execution_workspace_id" text,
	"workspace_adopted_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"superseded_by_id" text,
	"released_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "execution_assignments_run_epoch_uq" UNIQUE("run_id","epoch"),
	CONSTRAINT "execution_assignments_epoch_check" CHECK ("execution_assignments"."epoch" >= 1),
	CONSTRAINT "execution_assignments_state_check" CHECK ("execution_assignments"."state" in ('active', 'superseded', 'released')),
	CONSTRAINT "execution_assignments_placement_reason_check" CHECK ("execution_assignments"."placement_reason" in ('launch', 'resume', 'recover', 'wait_resume', 'rework_return', 'gate_chat', 'sync_resolver', 'scratch_recover', 'node_interrupt', 'legacy_backfill')),
	CONSTRAINT "execution_assignments_active_shape_check" CHECK (("execution_assignments"."state" = 'active') = ("execution_assignments"."ended_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"execution_assignment_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"assignment_epoch" integer NOT NULL,
	"kind" text NOT NULL,
	"target_session_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivering_since" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"last_error" jsonb,
	"driverless" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.release', 'session.create', 'session.prompt', 'session.input', 'session.cancel', 'session.checkpoint', 'session.delete')),
	CONSTRAINT "execution_commands_state_check" CHECK ("execution_commands"."state" in ('queued', 'delivering', 'accepted', 'succeeded', 'failed', 'fenced')),
	CONSTRAINT "execution_commands_terminal_shape_check" CHECK (("execution_commands"."state" in ('succeeded', 'failed', 'fenced')) = ("execution_commands"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"host_key" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"transport" jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"readiness" text DEFAULT 'unknown' NOT NULL,
	"readiness_reason" text,
	"last_boot_id" text,
	"last_seen_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "execution_hosts_host_key_unique" UNIQUE("host_key"),
	CONSTRAINT "execution_hosts_kind_check" CHECK ("execution_hosts"."kind" in ('local_direct')),
	CONSTRAINT "execution_hosts_readiness_check" CHECK ("execution_hosts"."readiness" in ('unknown', 'ready', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD COLUMN "host_session_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_assignment_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_superseded_by_id_execution_assignments_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_assignments_run_active_uq" ON "execution_assignments" USING btree ("run_id") WHERE "execution_assignments"."state" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_assignments_host_state_idx" ON "execution_assignments" USING btree ("execution_host_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_open_idx" ON "execution_commands" USING btree ("state","next_attempt_at") WHERE "execution_commands"."state" in ('queued', 'delivering', 'accepted');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_run_created_idx" ON "execution_commands" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_commands_assignment_idx" ON "execution_commands" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_hosts_local_active_uq" ON "execution_hosts" USING btree ("kind") WHERE "execution_hosts"."kind" = 'local_direct' AND "execution_hosts"."retired_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_sessions" ADD CONSTRAINT "run_sessions_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_attempts_assignment_idx" ON "node_attempts" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_sessions_host_session_idx" ON "run_sessions" USING btree ("host_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_sessions_assignment_idx" ON "run_sessions" USING btree ("execution_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_execution_assignment_idx" ON "runs" USING btree ("execution_assignment_id");