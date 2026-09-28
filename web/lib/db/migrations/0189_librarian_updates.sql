CREATE TABLE IF NOT EXISTS "librarian_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"domain_event_id" bigint NOT NULL,
	"task_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "librarian_updates_event_uq" UNIQUE("conversation_id","domain_event_id"),
	CONSTRAINT "librarian_updates_status_check" CHECK ("librarian_updates"."status" IN ('pending', 'delivered', 'skipped_no_access', 'failed')),
	CONSTRAINT "librarian_updates_attempts_check" CHECK ("librarian_updates"."attempts" >= 0),
	CONSTRAINT "librarian_updates_failed_has_error_check" CHECK ("librarian_updates"."status" <> 'failed' OR "librarian_updates"."last_error_code" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_updates" ADD CONSTRAINT "librarian_updates_conversation_id_librarian_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."librarian_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_updates" ADD CONSTRAINT "librarian_updates_domain_event_id_domain_events_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_updates" ADD CONSTRAINT "librarian_updates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_updates" ADD CONSTRAINT "librarian_updates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "librarian_updates" ADD CONSTRAINT "librarian_updates_message_id_librarian_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."librarian_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "librarian_updates_conversation_created_idx" ON "librarian_updates" USING btree ("conversation_id","created_at");