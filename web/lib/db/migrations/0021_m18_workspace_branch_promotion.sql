ALTER TABLE "projects" ADD COLUMN "promotion_mode" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "base_commit" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_mode" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "promotion_attempt_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_promotion_owner_user_id_users_id_fk" FOREIGN KEY ("promotion_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
UPDATE "workspaces" w
SET "promotion_mode" = COALESCE(p."promotion_mode", 'local_merge'),
    "target_branch" = p."main_branch"
FROM "projects" p
WHERE w."project_id" = p."id"
  AND w."promotion_mode" IS NULL;
