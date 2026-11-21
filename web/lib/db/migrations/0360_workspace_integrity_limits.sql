ALTER TABLE "platform_runtime_settings" ADD COLUMN "workspace_integrity_max_size_mib" integer;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "workspace_integrity_max_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD COLUMN "workspace_integrity_max_entries" integer;--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD CONSTRAINT "platform_workspace_integrity_size_range" CHECK ("platform_runtime_settings"."workspace_integrity_max_size_mib" BETWEEN 1 AND 8192);--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD CONSTRAINT "platform_workspace_integrity_duration_range" CHECK ("platform_runtime_settings"."workspace_integrity_max_duration_seconds" BETWEEN 1 AND 240);--> statement-breakpoint
ALTER TABLE "platform_runtime_settings" ADD CONSTRAINT "platform_workspace_integrity_entries_range" CHECK ("platform_runtime_settings"."workspace_integrity_max_entries" BETWEEN 1 AND 500000);