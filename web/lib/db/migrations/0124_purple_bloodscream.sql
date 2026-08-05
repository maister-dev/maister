ALTER TABLE "agent_project_links" ADD COLUMN "context_repos" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_mounts" jsonb;