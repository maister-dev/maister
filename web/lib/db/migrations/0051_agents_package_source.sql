-- Pre-release substrate reshape (ADR-089 rework): host-catalog rows carry no
-- package provenance, so the NOT NULL provenance columns below cannot be
-- backfilled — the catalog re-registers from installed flow packages on the
-- next install/resync. Links/schedules cascade; runs.agent_id SET NULLs.
DELETE FROM "agents";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_scope_project_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "agents_project_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "flow_ref_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "version_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "origin" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recommended" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_ref" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_flow_ref_idx" ON "agents" USING btree ("flow_ref_id");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "scope";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "project_id";