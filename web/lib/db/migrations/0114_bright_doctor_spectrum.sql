CREATE TABLE IF NOT EXISTS "evaluation_standardized_recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"slot" text DEFAULT 'default' NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"source_study_id" text,
	"source_recipe_id" text,
	"source_verdict_id" text,
	"definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"rolled_back_to_revision" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_standardized_recipes_revision_uq" UNIQUE("project_id","slot","revision"),
	CONSTRAINT "evaluation_standardized_recipes_action_check" CHECK ("evaluation_standardized_recipes"."action" in ('standardize', 'rollback'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_standardized_recipes" ADD CONSTRAINT "evaluation_standardized_recipes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_standardized_recipes" ADD CONSTRAINT "evaluation_standardized_recipes_source_study_id_evaluation_studies_id_fk" FOREIGN KEY ("source_study_id") REFERENCES "public"."evaluation_studies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_standardized_recipes" ADD CONSTRAINT "evaluation_standardized_recipes_source_recipe_id_evaluation_recipes_id_fk" FOREIGN KEY ("source_recipe_id") REFERENCES "public"."evaluation_recipes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_standardized_recipes" ADD CONSTRAINT "evaluation_standardized_recipes_source_verdict_id_evaluation_human_verdicts_id_fk" FOREIGN KEY ("source_verdict_id") REFERENCES "public"."evaluation_human_verdicts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_standardized_recipes" ADD CONSTRAINT "evaluation_standardized_recipes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_standardized_recipes_project_slot_idx" ON "evaluation_standardized_recipes" USING btree ("project_id","slot");