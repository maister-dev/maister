DROP TABLE IF EXISTS "flow_runner_remaps";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flow_runner_remaps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"flow_revision_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"mapped_runner_id" text,
	"status" text DEFAULT 'Pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_runner_remaps_project_revision_slot_uq" UNIQUE("project_id","flow_revision_id","slot_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_flow_revision_id_flow_revisions_id_fk" FOREIGN KEY ("flow_revision_id") REFERENCES "public"."flow_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_runner_remaps" ADD CONSTRAINT "flow_runner_remaps_mapped_runner_id_platform_acp_runners_id_fk" FOREIGN KEY ("mapped_runner_id") REFERENCES "public"."platform_acp_runners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runner_remaps_mapped_runner_idx" ON "flow_runner_remaps" USING btree ("mapped_runner_id");
