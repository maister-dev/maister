ALTER TABLE "agents" ADD COLUMN "config_schema" jsonb;--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_config" jsonb;
