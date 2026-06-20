ALTER TABLE "local_packages" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "local_packages" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "local_packages" ADD CONSTRAINT "local_packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "local_packages_default_per_project" ON "local_packages" USING btree ("project_id") WHERE "local_packages"."is_default";