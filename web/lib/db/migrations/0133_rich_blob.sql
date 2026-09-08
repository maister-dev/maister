CREATE TABLE IF NOT EXISTS "execution_runtime_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"execution_assignment_id" text,
	"assignment_epoch" integer,
	"run_session_incarnation_id" text,
	"kind" text NOT NULL,
	"logical_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"generation" integer NOT NULL,
	"retention_class" text NOT NULL,
	"state" text NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_error" jsonb,
	CONSTRAINT "execution_runtime_objects_size_check" CHECK ("execution_runtime_objects"."size_bytes" IS NULL OR "execution_runtime_objects"."size_bytes" >= 0),
	CONSTRAINT "execution_runtime_objects_generation_check" CHECK ("execution_runtime_objects"."generation" >= 1),
	CONSTRAINT "execution_runtime_objects_logical_name_check" CHECK (char_length("execution_runtime_objects"."logical_name") BETWEEN 1 AND 255 AND "execution_runtime_objects"."logical_name" NOT IN ('.', '..') AND "execution_runtime_objects"."logical_name" !~ '[\\/]'),
	CONSTRAINT "execution_runtime_objects_metadata_state_check" CHECK (("execution_runtime_objects"."state" IN ('available', 'deleting', 'missing', 'deleted', 'expired', 'corrupt')) = ("execution_runtime_objects"."size_bytes" IS NOT NULL AND "execution_runtime_objects"."sha256" ~ '^[a-f0-9]{64}$' AND "execution_runtime_objects"."sealed_at" IS NOT NULL)),
	CONSTRAINT "execution_runtime_objects_ephemeral_expiry_check" CHECK (("execution_runtime_objects"."retention_class" = 'ephemeral') = ("execution_runtime_objects"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_run_session_incarnation_id_run_session_incarnations_id_fk" FOREIGN KEY ("run_session_incarnation_id") REFERENCES "public"."run_session_incarnations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_runtime_objects" ADD CONSTRAINT "execution_runtime_objects_source_event_id_execution_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."execution_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_runtime_objects_source_event_uq" ON "execution_runtime_objects" USING btree ("source_event_id") WHERE "execution_runtime_objects"."source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_runtime_objects_run_state_idx" ON "execution_runtime_objects" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_runtime_objects_expiry_idx" ON "execution_runtime_objects" USING btree ("expires_at") WHERE "execution_runtime_objects"."expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.release', 'session.create', 'session.prompt', 'session.input', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete'));