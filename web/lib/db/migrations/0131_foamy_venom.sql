CREATE TABLE IF NOT EXISTS "execution_data_plane_imports" (
	"run_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"source_fingerprint" text,
	"last_source_position" text,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "execution_data_plane_imports_run_id_source_kind_pk" PRIMARY KEY("run_id","source_kind")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_event_consumers" (
	"consumer_name" text NOT NULL,
	"run_id" text NOT NULL,
	"last_run_sequence" bigint,
	"state" text DEFAULT 'ready' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"poison_event_id" text,
	"last_error" jsonb,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_event_consumers_consumer_name_run_id_pk" PRIMARY KEY("consumer_name","run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_event_ingest_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_host_id" text NOT NULL,
	"stream_id" text,
	"event_id_text" text,
	"sequence_text" text,
	"reason" text NOT NULL,
	"details" jsonb,
	"encoded_bytes" integer DEFAULT 0 NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_event_ingest_failures_identity_uq" UNIQUE("execution_host_id","stream_id","event_id_text","sequence_text","reason")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_event_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_host_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"state" text DEFAULT 'observed' NOT NULL,
	"last_received_sequence" bigint,
	"last_contiguous_sequence" bigint,
	"last_ack_confirmed_sequence" bigint,
	"replay_floor_sequence" bigint,
	"last_boot_id" text,
	"last_seen_at" timestamp with time zone,
	"first_gap_sequence" bigint,
	"gap_detected_at" timestamp with time zone,
	"gap_status" text,
	"last_error" jsonb,
	"next_retry_at" timestamp with time zone,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "execution_event_streams_host_stream_uq" UNIQUE("execution_host_id","stream_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_key" text,
	"run_id" text NOT NULL,
	"execution_host_id" text,
	"event_stream_id" text,
	"host_sequence" bigint,
	"execution_assignment_id" text,
	"assignment_epoch" integer,
	"run_session_incarnation_id" text,
	"host_boot_id" text,
	"host_session_id" text,
	"envelope_version" integer,
	"event_type" text NOT NULL,
	"payload_schema" text NOT NULL,
	"payload" jsonb,
	"payload_sha256" text,
	"payload_bytes" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_sequence" bigint,
	"ingest_disposition" text NOT NULL,
	"ingest_error" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_session_incarnations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"execution_assignment_id" text,
	"assignment_epoch" integer,
	"execution_host_id" text NOT NULL,
	"host_session_id" text NOT NULL,
	"host_boot_id" text,
	"acp_session_id" text,
	"state" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"terminal_reason" jsonb,
	CONSTRAINT "run_session_incarnations_host_session_uq" UNIQUE("execution_host_id","host_session_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_data_plane_mode" text DEFAULT 'legacy_file_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "next_execution_event_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "owner_kind" text;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "owner_ref" jsonb;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "logical_operation_key" text;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "request_schema" text;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "request_sha256" text;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD COLUMN "completion_applied_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_data_plane_imports" ADD CONSTRAINT "execution_data_plane_imports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_event_consumers" ADD CONSTRAINT "execution_event_consumers_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_event_consumers" ADD CONSTRAINT "execution_event_consumers_poison_event_id_execution_events_id_fk" FOREIGN KEY ("poison_event_id") REFERENCES "public"."execution_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_event_ingest_failures" ADD CONSTRAINT "execution_event_ingest_failures_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_event_streams" ADD CONSTRAINT "execution_event_streams_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_event_stream_id_execution_event_streams_id_fk" FOREIGN KEY ("event_stream_id") REFERENCES "public"."execution_event_streams"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_run_session_incarnation_id_run_session_incarnations_id_fk" FOREIGN KEY ("run_session_incarnation_id") REFERENCES "public"."run_session_incarnations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_session_incarnations" ADD CONSTRAINT "run_session_incarnations_run_session_id_run_sessions_id_fk" FOREIGN KEY ("run_session_id") REFERENCES "public"."run_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_session_incarnations" ADD CONSTRAINT "run_session_incarnations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_session_incarnations" ADD CONSTRAINT "run_session_incarnations_execution_assignment_id_execution_assignments_id_fk" FOREIGN KEY ("execution_assignment_id") REFERENCES "public"."execution_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_session_incarnations" ADD CONSTRAINT "run_session_incarnations_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_event_consumers_retry_idx" ON "execution_event_consumers" USING btree ("next_retry_at","claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_event_streams_active_host_uq" ON "execution_event_streams" USING btree ("execution_host_id") WHERE "execution_event_streams"."state" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_event_streams_retry_idx" ON "execution_event_streams" USING btree ("next_retry_at","claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_events_host_position_uq" ON "execution_events" USING btree ("event_stream_id","host_sequence") WHERE "execution_events"."event_stream_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_events_source_run_key_uq" ON "execution_events" USING btree ("source","run_id","source_key") WHERE "execution_events"."source_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_events_run_sequence_uq" ON "execution_events" USING btree ("run_id","run_sequence") WHERE "execution_events"."run_sequence" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_events_run_sequence_idx" ON "execution_events" USING btree ("run_id","run_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_session_incarnations_active_run_session_uq" ON "run_session_incarnations" USING btree ("run_session_id") WHERE "run_session_incarnations"."state" IN ('created', 'active', 'checkpointed');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_commands_prompt_logical_operation_uq" ON "execution_commands" USING btree ("run_id","logical_operation_key") WHERE "execution_commands"."kind" = 'session.prompt' AND "execution_commands"."logical_operation_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_execution_data_plane_mode_check" CHECK ("execution_data_plane_mode" IN ('legacy_file_v1', 'canonical_events_v1'));
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_next_execution_event_sequence_check" CHECK ("next_execution_event_sequence" >= 0);
--> statement-breakpoint
ALTER TABLE "execution_event_streams" ADD CONSTRAINT "execution_event_streams_state_check" CHECK ("state" IN ('observed', 'active', 'closed', 'lost'));
--> statement-breakpoint
ALTER TABLE "execution_event_streams" ADD CONSTRAINT "execution_event_streams_cursor_check" CHECK (("last_received_sequence" IS NULL OR "last_received_sequence" >= 0) AND ("last_contiguous_sequence" IS NULL OR "last_contiguous_sequence" >= 0) AND ("last_ack_confirmed_sequence" IS NULL OR "last_ack_confirmed_sequence" >= 0) AND ("replay_floor_sequence" IS NULL OR "replay_floor_sequence" >= 0) AND ("last_ack_confirmed_sequence" IS NULL OR "last_contiguous_sequence" IS NULL OR "last_ack_confirmed_sequence" <= "last_contiguous_sequence"));
--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_disposition_check" CHECK ("ingest_disposition" IN ('pending_gap', 'accepted', 'stale_epoch', 'quarantined') AND ("run_sequence" IS NULL OR "ingest_disposition" = 'accepted'));
ALTER TABLE "execution_data_plane_imports" ADD CONSTRAINT "execution_data_plane_imports_kind_state_check" CHECK ("source_kind" IN ('events', 'transcript', 'cost', 'runtime_objects', 'scratch_session') AND "state" IN ('pending', 'complete', 'missing', 'failed') AND "imported_count" >= 0 AND "attempts" >= 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maister_runs_execution_data_plane_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_data_plane_mode IS DISTINCT FROM OLD.execution_data_plane_mode THEN
    RAISE EXCEPTION 'execution_data_plane_mode_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_execution_data_plane_mode_immutable BEFORE UPDATE OF execution_data_plane_mode ON "runs" FOR EACH ROW EXECUTE FUNCTION maister_runs_execution_data_plane_mode_immutable();
--> statement-breakpoint
INSERT INTO "execution_data_plane_imports" ("run_id", "source_kind", "state")
SELECT "id", source_kind, 'pending'
FROM "runs" CROSS JOIN (VALUES ('events'), ('transcript'), ('cost'), ('runtime_objects'), ('scratch_session')) AS kinds(source_kind)
ON CONFLICT ("run_id", "source_kind") DO NOTHING;
