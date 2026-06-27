-- M42 (ADR-114): `run_sessions` becomes the SOLE source of truth for per-run
-- runner/resume state. Backfill one `default` session per existing run from the
-- about-to-be-dropped `runs` mirror BEFORE dropping the columns, so live runs
-- keep their resume handle (acp_session_id) + runner snapshot — recovery, stop,
-- gate-chat, and diagnostics can still target the correct ACP session. Idempotent
-- (ON CONFLICT) and skips runs that never resolved a runner/session.
INSERT INTO "run_sessions" (
	"id", "run_id", "session_name", "runner_id", "runner_resolution_tier",
	"capability_agent", "runner_snapshot", "acp_session_id", "resolution_source",
	"created_at", "updated_at"
)
SELECT
	"runs"."id" || ':default', "runs"."id", 'default', "runs"."runner_id",
	"runs"."runner_resolution_tier", "runs"."capability_agent",
	"runs"."runner_snapshot", "runs"."acp_session_id", NULL, now(), now()
FROM "runs"
WHERE "runs"."runner_id" IS NOT NULL
	OR "runs"."runner_resolution_tier" IS NOT NULL
	OR "runs"."capability_agent" IS NOT NULL
	OR "runs"."runner_snapshot" IS NOT NULL
	OR "runs"."acp_session_id" IS NOT NULL
ON CONFLICT ("run_id", "session_name") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_runner_id_platform_acp_runners_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "runs_runner_idx";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_resolution_tier";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "capability_agent";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "runner_snapshot";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "acp_session_id";