ALTER TABLE "projects" ADD COLUMN "auto_promotion" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "promotion_hold" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_lane" text;