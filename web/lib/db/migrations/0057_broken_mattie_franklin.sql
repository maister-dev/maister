CREATE TABLE IF NOT EXISTS "local_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"working_dir" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_install_id" text,
	"source_repo_url" text,
	"source_ref" text,
	"branch_name" text,
	"last_cut_install_id" text,
	"locked_by_user_id" text,
	"locked_by_session" text,
	"lock_expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_packages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_packages" ADD CONSTRAINT "local_packages_source_install_id_package_installs_id_fk" FOREIGN KEY ("source_install_id") REFERENCES "public"."package_installs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_packages" ADD CONSTRAINT "local_packages_last_cut_install_id_package_installs_id_fk" FOREIGN KEY ("last_cut_install_id") REFERENCES "public"."package_installs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_packages" ADD CONSTRAINT "local_packages_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_packages" ADD CONSTRAINT "local_packages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
