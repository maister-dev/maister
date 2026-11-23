CREATE TABLE "project_package_mcp_scope_overrides" (
	"attachment_id" text NOT NULL,
	"ref_id" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "project_package_mcp_scope_overrides_attachment_id_ref_id_pk" PRIMARY KEY("attachment_id","ref_id"),
	CONSTRAINT "project_package_mcp_scope_valid" CHECK ("project_package_mcp_scope_overrides"."scope" IN ('package', 'project'))
);
--> statement-breakpoint
ALTER TABLE "project_package_attachments" ADD COLUMN "scope_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_package_mcp_scope_overrides" ADD CONSTRAINT "project_package_mcp_scope_overrides_attachment_id_project_package_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."project_package_attachments"("id") ON DELETE cascade ON UPDATE no action;