ALTER TABLE "projects" ADD COLUMN "execution_policy_default" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "execution_policy" jsonb DEFAULT '{"preset":"supervised"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "execution_policy" jsonb;