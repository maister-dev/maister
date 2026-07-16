CREATE TABLE IF NOT EXISTS "evaluation_judge_panels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"role_bindings" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_method_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"package_install_id" text NOT NULL,
	"method_id" text NOT NULL,
	"qualified_id" text NOT NULL,
	"package_name" text NOT NULL,
	"version_label" text NOT NULL,
	"schema_version" integer NOT NULL,
	"normalized_definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"schema_digest" text NOT NULL,
	"compat" jsonb NOT NULL,
	"activation" text DEFAULT 'disabled' NOT NULL,
	"validation_errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_method_revisions_install_method_uq" UNIQUE("package_install_id","method_id"),
	CONSTRAINT "evaluation_method_revisions_activation_check" CHECK ("evaluation_method_revisions"."activation" in ('enabled', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"method_revision_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"defaults" jsonb,
	"hard_limits" jsonb,
	"allowed_overrides" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_project_profile_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"overrides" jsonb NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_project_profile_overrides_project_profile_uq" UNIQUE("project_id","profile_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_panels" ADD CONSTRAINT "evaluation_judge_panels_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_judge_panels" ADD CONSTRAINT "evaluation_judge_panels_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_method_revisions" ADD CONSTRAINT "evaluation_method_revisions_package_install_id_package_installs_id_fk" FOREIGN KEY ("package_install_id") REFERENCES "public"."package_installs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_method_revision_id_evaluation_method_revisions_id_fk" FOREIGN KEY ("method_revision_id") REFERENCES "public"."evaluation_method_revisions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_panel_id_evaluation_judge_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."evaluation_judge_panels"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_project_profile_overrides" ADD CONSTRAINT "evaluation_project_profile_overrides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_project_profile_overrides" ADD CONSTRAINT "evaluation_project_profile_overrides_profile_id_evaluation_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."evaluation_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_project_profile_overrides" ADD CONSTRAINT "evaluation_project_profile_overrides_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_judge_panels_enabled_idx" ON "evaluation_judge_panels" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_method_revisions_qualified_idx" ON "evaluation_method_revisions" USING btree ("qualified_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_profiles_method_idx" ON "evaluation_profiles" USING btree ("method_revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_profiles_panel_idx" ON "evaluation_profiles" USING btree ("panel_id");