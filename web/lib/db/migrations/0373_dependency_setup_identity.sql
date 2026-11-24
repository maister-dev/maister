ALTER TABLE "project_dependency_setup_receipts" ADD COLUMN "physical_key" text;--> statement-breakpoint
ALTER TABLE "project_dependency_setup_receipts" ADD COLUMN "script_digest" text;--> statement-breakpoint
ALTER TABLE "project_dependency_setup_receipts" ADD COLUMN "content_witness" text;--> statement-breakpoint
ALTER TABLE "project_dependency_setup_receipts" ADD CONSTRAINT "project_dependency_setup_receipts_physical_key_unique" UNIQUE("physical_key");