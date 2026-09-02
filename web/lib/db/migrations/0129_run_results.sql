CREATE TABLE IF NOT EXISTS "run_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"revision" integer NOT NULL,
	"validity" text NOT NULL,
	"schema_ref" text NOT NULL,
	"schema_sha256" text NOT NULL,
	"schema_version" integer NOT NULL,
	"producer_kind" text NOT NULL,
	"producer_ref" text NOT NULL,
	"node_attempt_id" text,
	"value" jsonb,
	"value_bytes" integer NOT NULL,
	"invalid_reason" text,
	"artifact_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"superseded_by_id" text,
	"superseded_at" timestamp with time zone,
	"first_collected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_results_run_revision_uq" UNIQUE("run_id","revision"),
	CONSTRAINT "run_results_validity_check" CHECK ("run_results"."validity" IN ('valid','stale','superseded','invalid')),
	CONSTRAINT "run_results_producer_kind_check" CHECK ("run_results"."producer_kind" IN ('flow_node','agent_session')),
	CONSTRAINT "run_results_value_shape_check" CHECK (("run_results"."validity" = 'invalid') = ("run_results"."value" IS NULL)),
	CONSTRAINT "run_results_invalid_reason_check" CHECK (("run_results"."validity" = 'invalid') = ("run_results"."invalid_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "flow_revisions" ADD COLUMN "result_profiles" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "result_contract" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "delegation_bounds" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_results" ADD CONSTRAINT "run_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_results" ADD CONSTRAINT "run_results_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_results" ADD CONSTRAINT "run_results_superseded_by_id_run_results_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."run_results"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_results_one_valid_per_run_uq" ON "run_results" USING btree ("run_id") WHERE "run_results"."validity" = 'valid';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_results_run_idx" ON "run_results" USING btree ("run_id");