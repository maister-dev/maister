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
