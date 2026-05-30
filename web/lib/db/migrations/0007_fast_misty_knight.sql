CREATE TABLE IF NOT EXISTS "flow_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_ref_id" text NOT NULL,
	"source" text NOT NULL,
	"version_label" text NOT NULL,
	"resolved_revision" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"engine_min" text,
	"engine_max" text,
	"contract" jsonb,
	"installed_path" text NOT NULL,
	"setup_status" text DEFAULT 'pending' NOT NULL,
	"package_status" text DEFAULT 'Installing' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_revisions_ref_revision_uq" UNIQUE("flow_ref_id","resolved_revision")
);
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "enabled_revision_id" text;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "enablement_state" text DEFAULT 'Installed' NOT NULL;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "trust_status" text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "flow_revision_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flows" ADD CONSTRAINT "flows_enabled_revision_id_flow_revisions_id_fk" FOREIGN KEY ("enabled_revision_id") REFERENCES "public"."flow_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_flow_revision_id_flow_revisions_id_fk" FOREIGN KEY ("flow_revision_id") REFERENCES "public"."flow_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
