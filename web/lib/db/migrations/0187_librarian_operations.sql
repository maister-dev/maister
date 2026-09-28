CREATE TABLE IF NOT EXISTS "librarian_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"message_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"target" jsonb NOT NULL,
	"target_revision" text,
	"payload" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"requires_owner" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_cards_kind_check" CHECK ("librarian_cards"."kind" IN ('statement_proposal', 'confirmation', 'memory_suggestion')),
	CONSTRAINT "librarian_cards_status_check" CHECK ("librarian_cards"."status" IN ('pending', 'accepted', 'rejected', 'expired', 'superseded', 'cleared_by_reset'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"turn_id" text,
	"card_id" text,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"target" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "librarian_operations_key_uq" UNIQUE("conversation_id","idempotency_key"),
	CONSTRAINT "librarian_operations_status_check" CHECK ("librarian_operations"."status" IN ('admitted', 'succeeded', 'refused', 'failed', 'unknown')),
	CONSTRAINT "librarian_operations_terminal_shape_check" CHECK ("librarian_operations"."status" NOT IN ('refused', 'failed') OR "librarian_operations"."error_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "librarian_task_links" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"meaning" text NOT NULL,
	"from_message_id" text,
	"to_message_id" text,
	"statement_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "librarian_task_links_meaning_check" CHECK ("librarian_task_links"."meaning" IN ('created_from', 'refined_in', 'mentioned'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_statement_revisions" (
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"statement" jsonb NOT NULL,
	"author_actor_type" text NOT NULL,
	"author_actor_id" text,
	"via_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_statement_revisions_task_id_revision_pk" PRIMARY KEY("task_id","revision")
);
--> statement-breakpoint
ALTER TABLE "task_activity" DROP CONSTRAINT "task_activity_event_kind_check";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "via_operation_id" text;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "via_operation_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_segment_id_librarian_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."librarian_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_message_id_librarian_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_operations" ADD CONSTRAINT "librarian_operations_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_operations" ADD CONSTRAINT "librarian_operations_segment_id_librarian_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."librarian_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_operations" ADD CONSTRAINT "librarian_operations_turn_id_librarian_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."librarian_turns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_task_links" ADD CONSTRAINT "librarian_task_links_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_task_links" ADD CONSTRAINT "librarian_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_task_links" ADD CONSTRAINT "librarian_task_links_from_message_id_librarian_messages_id_fk" FOREIGN KEY ("from_message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_task_links" ADD CONSTRAINT "librarian_task_links_to_message_id_librarian_messages_id_fk" FOREIGN KEY ("to_message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_statement_revisions" ADD CONSTRAINT "task_statement_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_cards_pending_idx" ON "librarian_cards" USING btree ("conversation_id") WHERE "librarian_cards"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_operations_segment_digest_idx" ON "librarian_operations" USING btree ("segment_id","request_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_task_links_task_idx" ON "librarian_task_links" USING btree ("task_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_via_operation_uq" UNIQUE("via_operation_id");--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_via_operation_uq" UNIQUE("via_operation_id");--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'evaluation_decided', 'agent_summon_suppressed', 'statement_accepted'));
--> statement-breakpoint
CREATE FUNCTION task_statement_revisions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'task_statement_revisions_immutable',
    MESSAGE = 'an accepted task statement revision is immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER task_statement_revisions_immutable
  BEFORE UPDATE OR DELETE ON task_statement_revisions
  FOR EACH ROW EXECUTE FUNCTION task_statement_revisions_immutable();
--> statement-breakpoint
CREATE FUNCTION guard_agent_turn_user_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requested_by_user_id IS NOT NULL
    AND NEW.variant NOT IN ('live_message', 'persistent_message', 'steer') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_user_source_check',
      MESSAGE = 'a user-sourced agent turn must be a message or steer';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_user_source_immutable',
      MESSAGE = 'an accepted agent turn user source is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_agent_turn_user_source
  BEFORE INSERT OR UPDATE ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION guard_agent_turn_user_source();
