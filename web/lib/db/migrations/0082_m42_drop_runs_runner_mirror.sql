ALTER TABLE "runs" DROP CONSTRAINT "runs_runner_id_platform_acp_runners_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "runs_runner_idx";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_resolution_tier";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "capability_agent";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_snapshot";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "acp_session_id";