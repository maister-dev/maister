-- ADR-106 data policy: re-keying agent identity per-flow → per-package is a
-- pre-release reset. DELETE every catalog row FIRST (so `package_name NOT NULL`
-- can be added to an empty table), then a post-migration resync re-projects the
-- catalog from installed packages (startup reconcile + admin resync). The FK
-- fan-out makes the wipe safe: agent_project_links + agent_schedules
-- CASCADE-delete; runs.agent_id is ON DELETE SET NULL, so run history survives.
DELETE FROM "agents";--> statement-breakpoint
DROP INDEX IF EXISTS "agents_flow_ref_idx";--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "branch_base" text;--> statement-breakpoint
ALTER TABLE "agent_project_links" ADD COLUMN "execution_policy_override" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "package_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "flow_ref" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "branch_base" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_package_name_idx" ON "agents" USING btree ("package_name");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "flow_ref_id";