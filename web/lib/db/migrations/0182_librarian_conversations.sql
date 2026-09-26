CREATE TABLE IF NOT EXISTS "librarian_context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"instructions_version" text NOT NULL,
	"message_ids" text[] NOT NULL,
	"summary_revisions" jsonb NOT NULL,
	"memory_item_revisions" jsonb NOT NULL,
	"authz_fingerprint" text NOT NULL,
	"context_epoch" integer NOT NULL,
	"char_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"context_epoch" integer DEFAULT 0 NOT NULL,
	"forget_generation" integer DEFAULT 0 NOT NULL,
	"history_generation" integer DEFAULT 0 NOT NULL,
	"current_segment_id" text,
	"reset_state" text DEFAULT 'none' NOT NULL,
	"subject" jsonb,
	"read_through_seq" bigint DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"memory_enabled_next_segment" boolean DEFAULT true NOT NULL,
	"daily_turn_date" date,
	"daily_turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_conversations_user_uq" UNIQUE("user_id"),
	CONSTRAINT "librarian_conversations_run_uq" UNIQUE("run_id"),
	CONSTRAINT "librarian_conversations_reset_state_check" CHECK ("librarian_conversations"."reset_state" IN ('none', 'resetting', 'clearing'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"author_kind" text NOT NULL,
	"client_message_id" text,
	"body" text NOT NULL,
	"body_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "librarian_messages"."body")) STORED,
	"subject" jsonb,
	"delivery_state" text DEFAULT 'accepted' NOT NULL,
	"turn_id" text,
	"source_project_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"card_id" text,
	"update_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_messages_seq_uq" UNIQUE("conversation_id","seq"),
	CONSTRAINT "librarian_messages_author_kind_check" CHECK ("librarian_messages"."author_kind" IN ('owner', 'librarian', 'update', 'system')),
	CONSTRAINT "librarian_messages_delivery_state_check" CHECK ("librarian_messages"."delivery_state" IN ('accepted', 'queued', 'withdrawn', 'withdrawn_by_reset', 'processed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "librarian_segments_ordinal_uq" UNIQUE("conversation_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"message_id" text,
	"variant" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"context_snapshot_id" text,
	"runner_snapshot" jsonb,
	"token_id" text,
	"start_attempts" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"admitted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_turns_variant_check" CHECK ("librarian_turns"."variant" IN ('owner_message', 'explain', 'summary')),
	CONSTRAINT "librarian_turns_status_check" CHECK ("librarian_turns"."status" IN ('queued', 'admitted', 'running', 'completed', 'stopped', 'failed', 'withdrawn')),
	CONSTRAINT "librarian_turns_running_has_snapshot_check" CHECK ("librarian_turns"."status" <> 'running' OR "librarian_turns"."context_snapshot_id" IS NOT NULL),
	CONSTRAINT "librarian_turns_failed_has_reason_check" CHECK ("librarian_turns"."status" <> 'failed' OR "librarian_turns"."failure_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "librarian_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "librarian_runner_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_context_snapshots" ADD CONSTRAINT "librarian_context_snapshots_turn_id_librarian_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."librarian_turns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_conversations" ADD CONSTRAINT "librarian_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_conversations" ADD CONSTRAINT "librarian_conversations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_messages" ADD CONSTRAINT "librarian_messages_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_messages" ADD CONSTRAINT "librarian_messages_segment_id_librarian_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."librarian_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_segments" ADD CONSTRAINT "librarian_segments_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_turns" ADD CONSTRAINT "librarian_turns_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_turns" ADD CONSTRAINT "librarian_turns_segment_id_librarian_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."librarian_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_turns" ADD CONSTRAINT "librarian_turns_message_id_librarian_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_context_snapshots_turn_idx" ON "librarian_context_snapshots" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "librarian_messages_client_id_uq" ON "librarian_messages" USING btree ("conversation_id","client_message_id") WHERE "librarian_messages"."client_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_messages_body_tsv_idx" ON "librarian_messages" USING gin ("body_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "librarian_turns_one_active_uq" ON "librarian_turns" USING btree ("conversation_id") WHERE "librarian_turns"."status" IN ('admitted', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "librarian_turns_one_summary_uq" ON "librarian_turns" USING btree ("segment_id") WHERE "librarian_turns"."variant" = 'summary' AND "librarian_turns"."status" IN ('queued', 'admitted', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_turns_conversation_status_idx" ON "librarian_turns" USING btree ("conversation_id","status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_runtime_settings" ADD CONSTRAINT "platform_runtime_settings_librarian_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("librarian_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_librarian_turn_fk" FOREIGN KEY ("librarian_turn_id") REFERENCES "public"."librarian_turns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
