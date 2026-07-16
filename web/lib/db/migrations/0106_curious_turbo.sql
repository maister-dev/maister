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
CREATE INDEX IF NOT EXISTS "workspace_reconciliation_findings_correlation_idx" ON "workspace_reconciliation_findings" USING btree ("project_id","run_id","workspace_id");