CREATE TABLE IF NOT EXISTS "package_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"name" text NOT NULL,
	"version_label" text NOT NULL,
	"resolved_revision" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"installed_path" text NOT NULL,
	"package_status" text DEFAULT 'Installing' NOT NULL,
	"trust_status" text DEFAULT 'untrusted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_installs_source_name_rev_uq" UNIQUE("source_url","name","resolved_revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "package_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"discovered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_sources_url_uq" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_package_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"package_install_id" text NOT NULL,
	"package_name" text NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_package_attachments_project_name_uq" UNIQUE("project_id","package_name")
);
--> statement-breakpoint
ALTER TABLE "platform_mcp_servers" ALTER COLUMN "supported_agents" SET DEFAULT '["claude","codex","gemini","opencode","mimo"]'::jsonb;--> statement-breakpoint
ALTER TABLE "capability_imports" ADD COLUMN "package_install_id" text;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "package_install_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_package_attachments" ADD CONSTRAINT "project_package_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_package_attachments" ADD CONSTRAINT "project_package_attachments_package_install_id_package_installs_id_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_imports" ADD CONSTRAINT "capability_imports_package_install_id_package_installs_id_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flows" ADD CONSTRAINT "flows_package_install_id_package_installs_id_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
