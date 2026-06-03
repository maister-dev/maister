CREATE TABLE IF NOT EXISTS "capability_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"capability_ref_id" text NOT NULL,
	"source" text NOT NULL,
	"version_tag" text NOT NULL,
	"resolved_revision" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"installed_path" text NOT NULL,
	"setup_status" text DEFAULT 'pending' NOT NULL,
	"package_status" text DEFAULT 'Installing' NOT NULL,
	"trust_status" text DEFAULT 'untrusted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_imports_project_ref_revision_uq" UNIQUE("project_id","capability_ref_id","resolved_revision")
);
--> statement-breakpoint
ALTER TABLE "node_attempts" ADD COLUMN "materialization_plan" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "capability_imports" ADD CONSTRAINT "capability_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
