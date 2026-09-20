-- ADR-176: the per-run bound for automated crash-recover re-entry.
--
-- Live-data premise: both columns are ADDITIVE with safe defaults — a NULL
-- next-retry is "eligible now" and a 0 attempt count is "full budget" — so
-- every existing row is already correct under the new predicate. No backfill,
-- no abort guard, no rewrite of an in-flight run's state.
--
-- NO partial index, measured rather than assumed. `EXPLAIN (ANALYZE, BUFFERS)`
-- over 50k runs (7,142 of them live flow candidates) shows the arm changes
-- neither the plan shape nor the execution time — 33.088 ms before, 33.149 ms
-- after with no eligible candidate, both a nested loop over `runs_pkey`. The
-- planner cannot use a one-branch partial index for an OR across arms, and
-- `ORDER BY id LIMIT 1` makes it prefer the primary key's ordered scan anyway,
-- so a `runs (id) WHERE run_kind='flow' AND status='Running' AND
-- resume_started_at IS NOT NULL` index was written, measured as unused by this
-- query, and removed rather than shipped as write cost nothing reads.

ALTER TABLE "runs" ADD COLUMN "crash_recover_next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "crash_recover_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_crash_recover_attempts_check" CHECK ("runs"."crash_recover_attempts" >= 0);