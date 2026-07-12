ALTER TABLE "local_packages" ADD COLUMN "sync_state" jsonb;--> statement-breakpoint
ALTER TABLE "package_sources" ADD COLUMN "kind" text DEFAULT 'git' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_sources" ADD COLUMN "base_branch" text;