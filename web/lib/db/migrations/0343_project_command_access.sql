ALTER TABLE "projects" ADD COLUMN "command_access_profile" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "command_access_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_command_access_revision_positive" CHECK ("projects"."command_access_revision" > 0);