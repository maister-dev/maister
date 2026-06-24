CREATE TABLE IF NOT EXISTS "consensus_round_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text NOT NULL,
	"round" integer NOT NULL,
	"verifier_key" text NOT NULL,
	"target_key" text NOT NULL,
	"parse_status" text NOT NULL,
	"verdict" text NOT NULL,
	"axes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disagreements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"raw_output_artifact_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consensus_round_verdicts_attempt_round_pair_uq" UNIQUE("node_attempt_id","round","verifier_key","target_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consensus_round_verdicts" ADD CONSTRAINT "consensus_round_verdicts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consensus_round_verdicts" ADD CONSTRAINT "consensus_round_verdicts_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consensus_round_verdicts" ADD CONSTRAINT "consensus_round_verdicts_raw_output_artifact_id_artifact_instances_id_fk" FOREIGN KEY ("raw_output_artifact_id") REFERENCES "public"."artifact_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consensus_round_verdicts_run_idx" ON "consensus_round_verdicts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consensus_round_verdicts_node_attempt_idx" ON "consensus_round_verdicts" USING btree ("node_attempt_id");
