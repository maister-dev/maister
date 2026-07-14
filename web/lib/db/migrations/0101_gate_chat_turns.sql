CREATE TABLE IF NOT EXISTS "gate_chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"hitl_request_id" text NOT NULL,
	"user_message_id" text NOT NULL,
	"agent_message_id" text,
	"state" text NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_chat_turns_state_check" CHECK ("gate_chat_turns"."state" in ('pending', 'completed', 'failed', 'aborted')),
	CONSTRAINT "gate_chat_turns_pending_lease_check" CHECK (("gate_chat_turns"."state" = 'pending' and "gate_chat_turns"."lease_expires_at" is not null and "gate_chat_turns"."completed_at" is null and "gate_chat_turns"."error_code" is null) or ("gate_chat_turns"."state" <> 'pending' and "gate_chat_turns"."lease_expires_at" is null))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_turns" ADD CONSTRAINT "gate_chat_turns_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_turns" ADD CONSTRAINT "gate_chat_turns_hitl_request_id_hitl_requests_id_fk" FOREIGN KEY ("hitl_request_id") REFERENCES "public"."hitl_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_turns" ADD CONSTRAINT "gate_chat_turns_user_message_id_gate_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."gate_chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_chat_turns" ADD CONSTRAINT "gate_chat_turns_agent_message_id_gate_chat_messages_id_fk" FOREIGN KEY ("agent_message_id") REFERENCES "public"."gate_chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_chat_turns_hitl_state_idx" ON "gate_chat_turns" USING btree ("hitl_request_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gate_chat_turns_pending_hitl_uq" ON "gate_chat_turns" USING btree ("hitl_request_id") WHERE "gate_chat_turns"."state" = 'pending';