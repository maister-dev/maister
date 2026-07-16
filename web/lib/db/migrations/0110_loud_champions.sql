CREATE TABLE IF NOT EXISTS "evaluation_suite_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"study_id" text NOT NULL,
	"task_id" text NOT NULL,
	"suite_version" integer NOT NULL,
	"scan_key" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_suite_studies_scan_uq" UNIQUE("suite_id","task_id","scan_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'scheduled' NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_trigger_revision" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_suites_kind_check" CHECK ("evaluation_suites"."kind" in ('scheduled', 'regression'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_suite_studies" ADD CONSTRAINT "evaluation_suite_studies_suite_id_evaluation_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."evaluation_suites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_suite_studies" ADD CONSTRAINT "evaluation_suite_studies_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_suite_studies" ADD CONSTRAINT "evaluation_suite_studies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_suites" ADD CONSTRAINT "evaluation_suites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_suites" ADD CONSTRAINT "evaluation_suites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_suite_studies_suite_idx" ON "evaluation_suite_studies" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_suites_project_idx" ON "evaluation_suites" USING btree ("project_id");