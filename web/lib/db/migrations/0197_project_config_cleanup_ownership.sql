ALTER TABLE "project_config_persist_operations" ADD COLUMN "cleanup_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_config_persist_operations" ADD COLUMN "cleanup_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_config_persist_operations" ADD COLUMN "cleanup_reason" text;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "owner_token" text;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "owner_process_id" integer;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "process_group" integer;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "cleanup_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "cleanup_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD COLUMN "cleanup_reason" text;--> statement-breakpoint
ALTER TABLE "project_config_persist_operations" ADD CONSTRAINT "project_config_persist_cleanup_check" CHECK (
      "project_config_persist_operations"."cleanup_state" IN ('pending','complete','retained')
      AND ("project_config_persist_operations"."cleanup_state" = 'pending' OR "project_config_persist_operations"."cleanup_checked_at" IS NOT NULL)
      AND ("project_config_persist_operations"."cleanup_state" <> 'retained' OR "project_config_persist_operations"."cleanup_reason" IS NOT NULL)
      AND ("project_config_persist_operations"."cleanup_reason" IS NULL OR "project_config_persist_operations"."cleanup_reason" IN ('unexpected_private_content','cleanup_failed','operation_busy','recovery_required','authority_changed')));--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD CONSTRAINT "project_config_push_cleanup_check" CHECK (
      "project_config_push_intents"."cleanup_state" IN ('pending','complete','retained')
      AND ("project_config_push_intents"."cleanup_state" = 'pending' OR "project_config_push_intents"."cleanup_checked_at" IS NOT NULL)
      AND ("project_config_push_intents"."cleanup_state" <> 'retained' OR "project_config_push_intents"."cleanup_reason" IS NOT NULL)
      AND ("project_config_push_intents"."cleanup_reason" IS NULL OR "project_config_push_intents"."cleanup_reason" IN ('unexpected_private_content','cleanup_failed','operation_busy','recovery_required','authority_changed')));--> statement-breakpoint
ALTER TABLE "project_config_push_intents" ADD CONSTRAINT "project_config_push_owner_check" CHECK (
      ("project_config_push_intents"."state" NOT IN ('pending','unknown') OR ("project_config_push_intents"."owner_token" IS NOT NULL AND "project_config_push_intents"."owner_process_id" IS NOT NULL AND "project_config_push_intents"."owner_process_id" > 0))
      AND ("project_config_push_intents"."process_group" IS NULL OR "project_config_push_intents"."process_group" > 0));