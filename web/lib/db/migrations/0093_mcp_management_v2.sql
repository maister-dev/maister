CREATE TABLE IF NOT EXISTS "project_mcp_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ref_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_overlay" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommended_hint" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_mcp_bindings_project_ref_uq" UNIQUE("project_id","ref_id"),
	CONSTRAINT "project_mcp_bindings_target_kind_check" CHECK ("project_mcp_bindings"."target_kind" in ('platform', 'project', 'package'))
);
--> statement-breakpoint
ALTER TABLE "platform_mcp_servers" ADD COLUMN IF NOT EXISTS "last_probe_status" text;--> statement-breakpoint
ALTER TABLE "platform_mcp_servers" ADD COLUMN IF NOT EXISTS "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_mcp_servers" ADD COLUMN IF NOT EXISTS "last_probe_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "withheld_mcps" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_mcp_bindings" ADD CONSTRAINT "project_mcp_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_mcp_bindings_project_idx" ON "project_mcp_bindings" USING btree ("project_id");--> statement-breakpoint
UPDATE "platform_mcp_servers" SET "trust_status" = 'trusted' WHERE "enabled" = true AND "trust_status" = 'untrusted';
