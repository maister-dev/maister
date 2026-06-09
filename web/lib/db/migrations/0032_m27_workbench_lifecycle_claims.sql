ALTER TABLE "workspaces"
  ADD COLUMN "lifecycle_operation_state" text DEFAULT 'none' NOT NULL,
  ADD COLUMN "lifecycle_operation_claimed_at" timestamp with time zone,
  ADD COLUMN "lifecycle_operation_attempt_id" text,
  ADD COLUMN "lifecycle_operation_name" text;
