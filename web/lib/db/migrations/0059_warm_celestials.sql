DROP INDEX IF EXISTS "scratch_runs_project_status_idx";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scratch_runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "local_package_id" text;--> statement-breakpoint
ALTER TABLE "scratch_runs" ADD COLUMN "local_package_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_local_package_id_local_packages_id_fk" FOREIGN KEY ("local_package_id") REFERENCES "public"."local_packages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_local_package_id_local_packages_id_fk" FOREIGN KEY ("local_package_id") REFERENCES "public"."local_packages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_runs_local_package_idx" ON "scratch_runs" USING btree ("local_package_id","dialog_status") WHERE "scratch_runs"."local_package_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scratch_runs_project_status_idx" ON "scratch_runs" USING btree ("project_id","dialog_status") WHERE "scratch_runs"."project_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "scratch_runs" ADD CONSTRAINT "scratch_runs_owner_xor_check" CHECK (("scratch_runs"."project_id" IS NOT NULL) <> ("scratch_runs"."local_package_id" IS NOT NULL));