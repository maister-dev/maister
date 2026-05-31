CREATE TABLE IF NOT EXISTS "gate_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_attempt_id" text NOT NULL,
	"gate_id" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'blocking' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict" jsonb,
	"input_artifact_refs" jsonb,
	"output_artifact_ref" text,
	"stale_from" jsonb,
	"overridden_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"decision" text,
	"workspace_policy" text,
	"rework_from_node" text,
	"acp_session_id" text,
	"stdout" text,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exit_code" integer,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "node_attempts_run_node_attempt_uq" UNIQUE("run_id","node_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "workspace_policy" text;--> statement-breakpoint
ALTER TABLE "hitl_requests" ADD COLUMN "rework_target" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_results_run_idx" ON "gate_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gate_results_node_attempt_idx" ON "gate_results" USING btree ("node_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_attempts_run_idx" ON "node_attempts" USING btree ("run_id");