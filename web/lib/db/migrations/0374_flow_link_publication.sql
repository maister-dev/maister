CREATE TABLE "project_flow_link_publications" (
	"operation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"flow_ref_id" text NOT NULL,
	"workspace_root" text NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "project_flow_link_publications_operation_id_flow_ref_id_pk" PRIMARY KEY("operation_id","flow_ref_id")
);
--> statement-breakpoint
ALTER TABLE "project_flow_link_publications" ADD CONSTRAINT "project_flow_link_publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_flow_link_publication_due_idx" ON "project_flow_link_publications" USING btree ("due_at");