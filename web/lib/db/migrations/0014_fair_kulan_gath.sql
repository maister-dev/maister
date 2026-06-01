ALTER TABLE "runs" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "scratch_attachments" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "scratch_attachments" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "scratch_attachments" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "scratch_attachments" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "scratch_attachments" ADD COLUMN "storage_path" text;--> statement-breakpoint
ALTER TABLE "scratch_runs" ADD COLUMN "work_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "scratch_runs" ADD COLUMN "reasoning_effort" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
UPDATE "runs"
SET "created_by_user_id" = "scratch_runs"."created_by_user_id"
FROM "scratch_runs"
WHERE "runs"."id" = "scratch_runs"."run_id"
  AND "runs"."created_by_user_id" IS NULL;
