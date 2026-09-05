CREATE TABLE IF NOT EXISTS "run_transcript_states" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text,
	"next_sequence" integer DEFAULT 0 NOT NULL,
	"open_text_sequence" integer,
	"open_thought_sequence" integer,
	"usage_sequence" integer,
	CONSTRAINT "run_transcript_states_run_attempt_uq" UNIQUE NULLS NOT DISTINCT("run_id","node_attempt_id")
);
--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "projection_tool_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_transcript_states" ADD CONSTRAINT "run_transcript_states_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_transcript_states" ADD CONSTRAINT "run_transcript_states_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_messages_projection_tool_idx" ON "run_messages" USING btree ("run_id","node_attempt_id","projection_tool_key","sequence" DESC NULLS LAST) WHERE "run_messages"."projection_tool_key" IS NOT NULL;