-- ADR-151 (agent mentions in task comments). ADDITIVE ONLY: no data-bearing
-- DROP, no backfill. The CHECK is dropped and re-added solely to widen it.
--
-- `task_activity_agent_summon_uq` is the structural idempotency backstop for
-- the suppression note: the agent_triggers consumer inserts with
-- ON CONFLICT DO NOTHING rather than reading first, so at-least-once event
-- redelivery cannot double the note and no TOCTOU window exists.
--
-- `inbox_items_event_kind_check` is deliberately NOT widened — the kind never
-- fans out to an inbox.
--
-- `agent_schedules` needs NO migration for the new `trigger_type = 'mention'`:
-- the column is plain text with a TS-only enum and no value CHECK, and both
-- shape CHECKs (agent_schedules_cron_shape_check,
-- agent_schedules_event_shape_check) are `<>`-guarded, so an all-null
-- cron/event mention row passes unchanged. Verified, not assumed — the
-- migration test asserts it.
ALTER TABLE "task_activity" DROP CONSTRAINT "task_activity_event_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_activity_agent_summon_uq" ON "task_activity" USING btree ("task_id",("payload"->>'agentId'),("payload"->>'triggerEventId')) WHERE "task_activity"."event_kind" = 'agent_summon_suppressed';--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched', 'triage_set', 'triage_requeued', 'agent_quarantined', 'experiment_concluded', 'run_pr_merged', 'evaluation_decided', 'agent_summon_suppressed'));