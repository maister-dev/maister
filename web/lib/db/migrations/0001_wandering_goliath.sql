CREATE TABLE IF NOT EXISTS "step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"step_type" text NOT NULL,
	"mode" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"acp_session_id" text,
	"stdout" text,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exit_code" integer,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "step_runs_run_step_attempt_uq" UNIQUE("run_id","step_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "current_step_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_runs_run_idx" ON "step_runs" USING btree ("run_id");