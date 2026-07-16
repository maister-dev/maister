CREATE TABLE IF NOT EXISTS "evaluation_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"run_id" text,
	"source_type" text NOT NULL,
	"recipe_id" text,
	"label" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"replicate_group" text,
	"replicate_ordinal" integer,
	"launch_reason" text,
	"run_identity" jsonb,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "evaluation_participants_source_type_check" CHECK ("evaluation_participants"."source_type" in ('observed', 'launched')),
	CONSTRAINT "evaluation_participants_observed_no_recipe_check" CHECK (("evaluation_participants"."source_type" = 'launched') or ("evaluation_participants"."recipe_id" is null and "evaluation_participants"."launch_reason" is null and "evaluation_participants"."replicate_ordinal" is null)),
	CONSTRAINT "evaluation_participants_replicate_positive_check" CHECK ("evaluation_participants"."replicate_ordinal" is null or "evaluation_participants"."replicate_ordinal" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"replicate_group" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "evaluation_recipes_study_key_uq" UNIQUE("study_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"purpose" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"legacy_experiment_id" text,
	"archived_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "evaluation_studies_legacy_experiment_uq" UNIQUE("legacy_experiment_id"),
	CONSTRAINT "evaluation_studies_status_check" CHECK ("evaluation_studies"."status" in ('draft', 'open', 'decided', 'archived'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_participants" ADD CONSTRAINT "evaluation_participants_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_participants" ADD CONSTRAINT "evaluation_participants_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_participants" ADD CONSTRAINT "evaluation_participants_recipe_id_evaluation_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."evaluation_recipes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_recipes" ADD CONSTRAINT "evaluation_recipes_study_id_evaluation_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_studies" ADD CONSTRAINT "evaluation_studies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_studies" ADD CONSTRAINT "evaluation_studies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_studies" ADD CONSTRAINT "evaluation_studies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_participants_study_idx" ON "evaluation_participants" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_participants_run_idx" ON "evaluation_participants" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_participants_live_run_uq" ON "evaluation_participants" USING btree ("study_id","run_id") WHERE "evaluation_participants"."run_id" is not null and "evaluation_participants"."removed_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_recipes_study_idx" ON "evaluation_recipes" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_studies_project_status_idx" ON "evaluation_studies" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_studies_task_idx" ON "evaluation_studies" USING btree ("task_id");