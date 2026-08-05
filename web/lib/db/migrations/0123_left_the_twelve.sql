ALTER TABLE "agent_project_links" ADD COLUMN "cross_project_reach" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_chain_depth" integer DEFAULT 0 NOT NULL;