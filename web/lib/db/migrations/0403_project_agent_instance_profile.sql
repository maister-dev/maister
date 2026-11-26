CREATE TABLE "agent_project_mcp_additions" (
	"link_id" text NOT NULL,
	"ref_id" text NOT NULL,
	CONSTRAINT "agent_project_mcp_additions_link_id_ref_id_pk" PRIMARY KEY("link_id","ref_id"),
	CONSTRAINT "agent_project_mcp_additions_ref_check" CHECK (length("agent_project_mcp_additions"."ref_id") BETWEEN 1 AND 128 AND "agent_project_mcp_additions"."ref_id" ~ '^[A-Za-z0-9._-]+$' AND "agent_project_mcp_additions"."ref_id" <> '.' AND position('..' IN "agent_project_mcp_additions"."ref_id") = 0)
);
--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "prompt_override" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "project_agent_profile" jsonb;--> statement-breakpoint
ALTER TABLE "agent_project_mcp_additions" ADD CONSTRAINT "agent_project_mcp_additions_link_id_agent_project_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."agent_project_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD CONSTRAINT "agent_project_links_prompt_check" CHECK ("agent_project_links"."prompt_override" IS NULL OR (length("agent_project_links"."prompt_override") <= 65536 AND "agent_project_links"."prompt_override" ~ '[^[:space:]]'));