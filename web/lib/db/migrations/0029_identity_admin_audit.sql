ALTER TABLE "users" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "updated_by" text;
