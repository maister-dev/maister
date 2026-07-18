CREATE TABLE IF NOT EXISTS "evaluation_aggregate_results" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"algorithm_id" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"calculations" jsonb NOT NULL,
	"display_values" jsonb,
	"caps" jsonb,
	"quorum" jsonb,
	"exclusions" jsonb,
	"dispersion" jsonb,
	"warnings" jsonb,
	"digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_criterion_results" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"participant_id" text,
	"criterion_id" text NOT NULL,
	"state" text NOT NULL,
	"score" numeric,
	"rationale" text,
	"confidence" numeric,
	"evidence_refs" jsonb,
	"objective_refs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_criterion_results_state_check" CHECK ("evaluation_criterion_results"."state" in ('scored', 'insufficient_evidence', 'not_applicable')),
	CONSTRAINT "evaluation_criterion_results_score_state_check" CHECK (("evaluation_criterion_results"."state" = 'scored' and "evaluation_criterion_results"."score" is not null) or ("evaluation_criterion_results"."state" <> 'scored' and "evaluation_criterion_results"."score" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"execution_id" text,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_events_study_sequence_uq" UNIQUE("study_id","sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_evidence_items" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"participant_id" text,
	"kind" text NOT NULL,
	"locator" text NOT NULL,
	"digest" text NOT NULL,
	"bytes" integer,
	"coverage_class" text NOT NULL,
	"inclusion_reason" text,
	"truncation" jsonb,
	"redaction" jsonb,
	"blob_key" text,
	"retention" text,
	"captured_at" timestamp with time zone,
	"source_watermark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_evidence_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"participant_watermarks" jsonb NOT NULL,
	"evidence_protocol_digest" text NOT NULL,
	"manifest_digest" text,
	"coverage_summary" jsonb,
	"warnings" jsonb,
	"storage_generation" text,
	"sealed_at" timestamp with time zone,
	"prepared_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_delete_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "evaluation_evidence_snapshots_status_check" CHECK ("evaluation_evidence_snapshots"."status" in ('preparing', 'sealed', 'pending_delete', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"method_revision_id" text,
	"evidence_snapshot_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_profile_snapshot" jsonb,
	"randomization_seed" text,
	"objective_policy_snapshot" jsonb,
	"judge_policy_snapshot" jsonb,
	"aggregation_policy_snapshot" jsonb,
	"idempotency_key" text,
	"request_digest" text,
	"terminal_reason" text,
	"retry_of" text,
	"requested_by_user_id" text,
	"cancelled_by_user_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "evaluation_executions_status_check" CHECK ("evaluation_executions"."status" in ('queued', 'capturing', 'checking', 'judging', 'aggregating', 'review_required', 'cancelling', 'completed', 'partial', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_human_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"supersedes_id" text,
	"outcome" text NOT NULL,
	"participant_ids" jsonb NOT NULL,
	"execution_ids" jsonb NOT NULL,
	"no_evaluation_evidence_ack" boolean DEFAULT false NOT NULL,
	"rationale" text,
	"acknowledged_warnings" jsonb,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_human_verdicts_outcome_check" CHECK ("evaluation_human_verdicts"."outcome" in ('winner', 'tie', 'inconclusive')),
	CONSTRAINT "evaluation_human_verdicts_zero_citation_check" CHECK (jsonb_array_length("evaluation_human_verdicts"."execution_ids") > 0 or "evaluation_human_verdicts"."no_evaluation_evidence_ack" = true)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_judge_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"role" text NOT NULL,
	"ordinal" integer NOT NULL,
	"retry_ordinal" integer DEFAULT 0 NOT NULL,
	"retry_of" text,
	"agent_id" text,
	"agent_revision" text,
	"agent_run_id" text,
	"intended_run_id" text,
	"token_id" text,
	"runner_snapshot" jsonb,
	"model_snapshot" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"sealed_result" jsonb,
	"result_digest" text,
	"prompt_digest" text,
	"schema_digest" text,
	"evidence_digest" text,
	"usage" jsonb,
	"cost" jsonb,
	"enqueued_at" timestamp with time zone,
	"running_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_judge_attempts_unique" UNIQUE("execution_id","role","ordinal","retry_ordinal"),
	CONSTRAINT "evaluation_judge_attempts_status_check" CHECK ("evaluation_judge_attempts"."status" in ('queued', 'running', 'completed', 'invalid', 'timed_out', 'cancelled', 'error'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_metric_results" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"participant_id" text,
	"metric_id" text NOT NULL,
	"metric_version" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"value" jsonb,
	"unit" text,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_metric_results_status_check" CHECK ("evaluation_metric_results"."status" in ('measured', 'unavailable', 'not_run'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_objective_check_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"participant_id" text,
	"check_id" text NOT NULL,
	"check_version" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"input_digest" text,
	"output_digest" text,
	"trusted_profile_provenance" jsonb,
	"log_evidence_item_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_objective_check_runs_unique" UNIQUE("execution_id","participant_id","check_id","attempt"),
	CONSTRAINT "evaluation_objective_check_runs_status_check" CHECK ("evaluation_objective_check_runs"."status" in ('queued', 'running', 'passed', 'failed', 'error', 'cancelled', 'not_run', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'required' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"flags" jsonb,
	"reviewer_user_id" text,
	"resolution" text,
	"rationale" text,
	"adjudicated_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "evaluation_reviews_kind_check" CHECK ("evaluation_reviews"."kind" in ('disagreement', 'escalation')),
	CONSTRAINT "evaluation_reviews_status_check" CHECK ("evaluation_reviews"."status" in ('required', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "evaluation_studies" ADD COLUMN "legacy_snapshot" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_aggregate_results" ADD CONSTRAINT "evaluation_aggregate_results_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_criterion_results" ADD CONSTRAINT "evaluation_criterion_results_attempt_id_evaluation_judge_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."evaluation_judge_attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_criterion_results" ADD CONSTRAINT "evaluation_criterion_results_participant_id_evaluation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."evaluation_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_events" ADD CONSTRAINT "evaluation_events_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_events" ADD CONSTRAINT "evaluation_events_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_evidence_items" ADD CONSTRAINT "evaluation_evidence_items_snapshot_id_evaluation_evidence_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."evaluation_evidence_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_evidence_items" ADD CONSTRAINT "evaluation_evidence_items_participant_id_evaluation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."evaluation_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_evidence_snapshots" ADD CONSTRAINT "evaluation_evidence_snapshots_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_evidence_snapshots" ADD CONSTRAINT "evaluation_evidence_snapshots_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_method_revision_id_evaluation_method_revisions_id_fk" FOREIGN KEY ("method_revision_id") REFERENCES "public"."evaluation_method_revisions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_evidence_snapshot_id_evaluation_evidence_snapshots_id_fk" FOREIGN KEY ("evidence_snapshot_id") REFERENCES "public"."evaluation_evidence_snapshots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_retry_of_evaluation_executions_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."evaluation_executions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_executions" ADD CONSTRAINT "evaluation_executions_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_human_verdicts" ADD CONSTRAINT "evaluation_human_verdicts_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_human_verdicts" ADD CONSTRAINT "evaluation_human_verdicts_supersedes_id_evaluation_human_verdicts_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."evaluation_human_verdicts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_human_verdicts" ADD CONSTRAINT "evaluation_human_verdicts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_attempts" ADD CONSTRAINT "evaluation_judge_attempts_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_attempts" ADD CONSTRAINT "evaluation_judge_attempts_retry_of_evaluation_judge_attempts_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."evaluation_judge_attempts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_attempts" ADD CONSTRAINT "evaluation_judge_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_attempts" ADD CONSTRAINT "evaluation_judge_attempts_agent_run_id_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_metric_results" ADD CONSTRAINT "evaluation_metric_results_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_metric_results" ADD CONSTRAINT "evaluation_metric_results_participant_id_evaluation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."evaluation_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_objective_check_runs" ADD CONSTRAINT "evaluation_objective_check_runs_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_objective_check_runs" ADD CONSTRAINT "evaluation_objective_check_runs_participant_id_evaluation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."evaluation_participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_objective_check_runs" ADD CONSTRAINT "evaluation_objective_check_runs_log_evidence_item_id_evaluation_evidence_items_id_fk" FOREIGN KEY ("log_evidence_item_id") REFERENCES "public"."evaluation_evidence_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reviews" ADD CONSTRAINT "evaluation_reviews_execution_id_evaluation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."evaluation_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reviews" ADD CONSTRAINT "evaluation_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_aggregate_results_execution_idx" ON "evaluation_aggregate_results" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_criterion_results_attempt_idx" ON "evaluation_criterion_results" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_events_study_idx" ON "evaluation_events" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_evidence_items_snapshot_idx" ON "evaluation_evidence_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_evidence_items_participant_idx" ON "evaluation_evidence_items" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_evidence_snapshots_study_idx" ON "evaluation_evidence_snapshots" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_evidence_snapshots_protocol_digest_idx" ON "evaluation_evidence_snapshots" USING btree ("evidence_protocol_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_executions_study_status_idx" ON "evaluation_executions" USING btree ("study_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_executions_study_idem_uq" ON "evaluation_executions" USING btree ("study_id","idempotency_key") WHERE "evaluation_executions"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_human_verdicts_study_idx" ON "evaluation_human_verdicts" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_judge_attempts_execution_idx" ON "evaluation_judge_attempts" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_metric_results_execution_idx" ON "evaluation_metric_results" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_objective_check_runs_execution_idx" ON "evaluation_objective_check_runs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_reviews_execution_idx" ON "evaluation_reviews" USING btree ("execution_id");