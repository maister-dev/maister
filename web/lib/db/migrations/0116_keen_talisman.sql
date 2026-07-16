CREATE TABLE IF NOT EXISTS "workspace_reconciliation_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_fingerprint" text NOT NULL,
	"candidate_kind" text NOT NULL,
	"relative_path" text NOT NULL,
	"provenance_version" integer,
	"provenance_fingerprint" text,
	"provenance_run_id" text,
	"project_id" text,
	"run_id" text,
	"workspace_id" text,
	"state" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"armed_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempt_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"result_code" text,
	"rescue_ref" text,
	"rescue_commit" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "workspace_reconciliation_findings_identity_fingerprint_unique" UNIQUE("identity_fingerprint"),
	CONSTRAINT "workspace_reconciliation_findings_candidate_kind_check" CHECK ("workspace_reconciliation_findings"."candidate_kind" IN ('row_missing_path', 'row_removed_path', 'rowless_managed', 'untrusted')),
	CONSTRAINT "workspace_reconciliation_findings_state_check" CHECK ("workspace_reconciliation_findings"."state" IN ('observed', 'held', 'retry_waiting', 'failed', 'quarantined', 'resolved')),
	CONSTRAINT "workspace_reconciliation_findings_rescue_evidence_check" CHECK (("workspace_reconciliation_findings"."rescue_ref" IS NULL) = ("workspace_reconciliation_findings"."rescue_commit" IS NULL)),
	CONSTRAINT "workspace_reconciliation_findings_claim_shape_check" CHECK (("workspace_reconciliation_findings"."attempt_id" IS NULL) = ("workspace_reconciliation_findings"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "archived_commit" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preservation_outcome" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "removal_kind" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lifecycle_operation_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lifecycle_operation_expected_run_status" text;--> statement-breakpoint
UPDATE "workspaces"
SET
	"removal_kind" = 'legacy',
	"preservation_outcome" = 'legacy_unknown'
WHERE "removed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "workspaces" AS "workspace"
SET
	"lifecycle_operation_state" = 'failed',
	"lifecycle_operation_claimed_at" = NULL,
	"lifecycle_operation_lease_expires_at" = NULL,
	"lifecycle_operation_expected_run_status" = "run"."status"
FROM "runs" AS "run"
WHERE "workspace"."run_id" = "run"."id"
	AND "workspace"."lifecycle_operation_state" = 'claiming';--> statement-breakpoint
UPDATE "workspaces"
SET
	"lifecycle_operation_state" = 'none',
	"lifecycle_operation_claimed_at" = NULL,
	"lifecycle_operation_attempt_id" = NULL,
	"lifecycle_operation_name" = NULL,
	"lifecycle_operation_lease_expires_at" = NULL,
	"lifecycle_operation_expected_run_status" = NULL
WHERE "lifecycle_operation_state" = 'failed'
	AND "lifecycle_operation_name" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_reconciliation_findings" ADD CONSTRAINT "workspace_reconciliation_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_reconciliation_findings" ADD CONSTRAINT "workspace_reconciliation_findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_reconciliation_findings" ADD CONSTRAINT "workspace_reconciliation_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_reconciliation_findings_due_idx" ON "workspace_reconciliation_findings" USING btree ("state","next_retry_at","first_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_reconciliation_findings_provenance_run_idx" ON "workspace_reconciliation_findings" USING btree ("provenance_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_reconciliation_findings_correlation_idx" ON "workspace_reconciliation_findings" USING btree ("project_id","run_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_lifecycle_claim_idx" ON "workspaces" USING btree ("lifecycle_operation_state","lifecycle_operation_lease_expires_at");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_lifecycle_claim_shape_check" CHECK ((
        ("workspaces"."lifecycle_operation_state" = 'none'
          AND "workspaces"."lifecycle_operation_attempt_id" IS NULL
          AND "workspaces"."lifecycle_operation_name" IS NULL
          AND "workspaces"."lifecycle_operation_expected_run_status" IS NULL
          AND "workspaces"."lifecycle_operation_lease_expires_at" IS NULL)
        OR
        ("workspaces"."lifecycle_operation_state" = 'claiming'
          AND "workspaces"."lifecycle_operation_attempt_id" IS NOT NULL
          AND "workspaces"."lifecycle_operation_name" IS NOT NULL
          AND "workspaces"."lifecycle_operation_expected_run_status" IS NOT NULL
          AND "workspaces"."lifecycle_operation_lease_expires_at" IS NOT NULL)
        OR
        ("workspaces"."lifecycle_operation_state" = 'failed'
          AND "workspaces"."lifecycle_operation_attempt_id" IS NOT NULL
          AND "workspaces"."lifecycle_operation_name" IS NOT NULL
          AND "workspaces"."lifecycle_operation_expected_run_status" IS NOT NULL
          AND "workspaces"."lifecycle_operation_lease_expires_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_preservation_outcome_check" CHECK ("workspaces"."preservation_outcome" IS NULL OR "workspaces"."preservation_outcome" IN ('not_needed', 'ref_created', 'snapshot_created', 'legacy_unknown'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_removal_kind_check" CHECK ("workspaces"."removal_kind" IS NULL OR "workspaces"."removal_kind" IN ('archive', 'drop', 'discard', 'retention_gc', 'reconciliation', 'legacy'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_removed_result_check" CHECK ("workspaces"."removed_at" IS NULL OR "workspaces"."removal_kind" IS NOT NULL);
