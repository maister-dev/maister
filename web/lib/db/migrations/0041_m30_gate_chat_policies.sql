CREATE TABLE IF NOT EXISTS "gate_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"hitl_request_id" text NOT NULL,
	"node_id" text NOT NULL,
	"gate_attempt" integer NOT NULL,
	"role" text NOT NULL,
	"author_user_id" text,
	"author_label" text NOT NULL,
	"body" text NOT NULL,
	"acp_session_id" text,
	"seq" integer NOT NULL,
	"mutation_reverted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_chat_messages_role_check" CHECK ("gate_chat_messages"."role" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "review_tip_sha" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "dirty_resolution" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "checkpoint_ref" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "session_policy" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "session_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "auto_retry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_messages" ADD CONSTRAINT "gate_chat_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_messages" ADD CONSTRAINT "gate_chat_messages_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_messages" ADD CONSTRAINT "gate_chat_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_chat_messages_run_idx" ON "gate_chat_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_chat_messages_hitl_request_idx" ON "gate_chat_messages" USING btree ("hitl_request_id");