CREATE TABLE IF NOT EXISTS "execution_runtime_object_retention_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor_created_at" timestamp with time zone,
	"cursor_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_runtime_object_retention_progress_cursor_check" CHECK (("execution_runtime_object_retention_progress"."cursor_created_at" IS NULL AND "execution_runtime_object_retention_progress"."cursor_id" IS NULL) OR ("execution_runtime_object_retention_progress"."cursor_created_at" IS NOT NULL AND "execution_runtime_object_retention_progress"."cursor_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "execution_runtime_objects" ADD COLUMN "retention_hold" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_runtime_objects_retention_scan_idx" ON "execution_runtime_objects" USING btree ("created_at","id") WHERE "execution_runtime_objects"."state" IN ('available', 'deleting');