CREATE TABLE "run_context_compactions" (
	"run_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"assignment_epoch" integer NOT NULL,
	"host_session_id" text NOT NULL,
	"node_attempt_id" text,
	"compaction_id" text NOT NULL,
	"status" text NOT NULL,
	"first_run_sequence" bigint NOT NULL,
	"last_run_sequence" bigint NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"command_id" text,
	"before_usage" jsonb,
	"after_usage" jsonb,
	CONSTRAINT "run_context_compactions_pk" PRIMARY KEY("run_id","execution_host_id","assignment_id","assignment_epoch","host_session_id","compaction_id"),
	CONSTRAINT "run_context_compactions_lifecycle_check" CHECK (
      "run_context_compactions"."assignment_epoch" > 0 AND length("run_context_compactions"."compaction_id") BETWEEN 1 AND 256
      AND "run_context_compactions"."first_run_sequence" BETWEEN 0 AND "run_context_compactions"."last_run_sequence"
      AND (("run_context_compactions"."status" = 'in_progress' AND "run_context_compactions"."started_at" IS NOT NULL AND "run_context_compactions"."ended_at" IS NULL)
        OR ("run_context_compactions"."status" IN ('completed', 'failed', 'cancelled', 'interrupted') AND "run_context_compactions"."ended_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "run_context_usage" (
	"run_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"assignment_epoch" integer NOT NULL,
	"host_session_id" text NOT NULL,
	"node_attempt_id" text,
	"used_tokens" bigint,
	"size_tokens" bigint,
	"observed_at" timestamp with time zone,
	"usage_run_sequence" bigint,
	"last_run_sequence" bigint NOT NULL,
	"created_run_sequence" bigint,
	CONSTRAINT "run_context_usage_scope_uq" UNIQUE NULLS NOT DISTINCT("run_id","execution_host_id","assignment_id","assignment_epoch","host_session_id","node_attempt_id"),
	CONSTRAINT "run_context_usage_measurement_check" CHECK (
      (num_nonnulls("run_context_usage"."used_tokens", "run_context_usage"."size_tokens", "run_context_usage"."observed_at", "run_context_usage"."usage_run_sequence") = 0 OR
        (num_nonnulls("run_context_usage"."used_tokens", "run_context_usage"."size_tokens", "run_context_usage"."observed_at", "run_context_usage"."usage_run_sequence") = 4 AND
         "run_context_usage"."used_tokens" BETWEEN 0 AND 9007199254740991 AND
         "run_context_usage"."size_tokens" BETWEEN 1 AND 9007199254740991 AND
         "run_context_usage"."usage_run_sequence" BETWEEN 0 AND "run_context_usage"."last_run_sequence"))
      AND "run_context_usage"."last_run_sequence" >= 0 AND "run_context_usage"."assignment_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "gate_results" ADD COLUMN "prompt_failure_reason" text;--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "run_context_compactions" ADD CONSTRAINT "run_context_compactions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_compactions" ADD CONSTRAINT "run_context_compactions_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD CONSTRAINT "run_context_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_usage" ADD CONSTRAINT "run_context_usage_node_attempt_id_node_attempts_id_fk" FOREIGN KEY ("node_attempt_id") REFERENCES "public"."node_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_context_compactions_status_idx" ON "run_context_compactions" USING btree ("run_id","execution_host_id","assignment_id","assignment_epoch","host_session_id","status");--> statement-breakpoint
CREATE INDEX "run_context_compactions_attempt_idx" ON "run_context_compactions" USING btree ("run_id","node_attempt_id");--> statement-breakpoint
CREATE INDEX "run_context_usage_attempt_idx" ON "run_context_usage" USING btree ("run_id","node_attempt_id","last_run_sequence");--> statement-breakpoint
ALTER TABLE "gate_results" ADD CONSTRAINT "gate_results_context_failure_reason_check" CHECK ("gate_results"."prompt_failure_reason" IS NULL OR "gate_results"."prompt_failure_reason" IN ('context_exhausted', 'max_output_tokens'));--> statement-breakpoint
ALTER TABLE "node_attempts" ADD CONSTRAINT "node_attempts_context_failure_reason_check" CHECK ("node_attempts"."error_reason" IS NULL OR ("node_attempts"."error_code" = 'ACP_PROTOCOL' AND "node_attempts"."error_reason" IN ('context_exhausted', 'max_output_tokens')) IS TRUE);