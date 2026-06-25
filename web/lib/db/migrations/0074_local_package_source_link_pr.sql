ALTER TABLE "local_packages" ADD COLUMN "last_pushed_branch" text;--> statement-breakpoint
ALTER TABLE "local_packages" ADD COLUMN "last_pr_url" text;--> statement-breakpoint
ALTER TABLE "package_installs" ADD COLUMN "source_local_package_id" text;--> statement-breakpoint
ALTER TABLE "package_installs" ADD COLUMN "source_commit_sha" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "package_installs" ADD CONSTRAINT "package_installs_source_local_package_id_local_packages_id_fk" FOREIGN KEY ("source_local_package_id") REFERENCES "public"."local_packages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
