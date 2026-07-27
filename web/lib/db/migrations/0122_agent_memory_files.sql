-- ADR-152 (agent memory files). ADDITIVE ONLY: two new columns, no DROP, no
-- data-bearing change, so neither a backfill nor an abort-guard is owed.
--
-- `agent_project_links.memory_enabled` is the per-attachment memory axis, a
-- SEPARATE store from Project Brain — neither `can_read_brain` nor
-- `can_write_brain` implies it, and the `agent_memory:write` token scope alone
-- does not authorize a write (both the scope AND this flag must pass). `false`
-- is the correct constant default rather than a "looks populated but isn't"
-- trap: a pre-existing attachment genuinely has no memory until an operator or
-- a re-attach prefill turns it on.
--
-- `runs.agent_memory_hash` is nullable and NULL means "this run injected no
-- memory" — the honest seed for every pre-0122 row and for every flow/scratch
-- run. It exists because the sibling `memory-snapshot.md` lives in the run dir,
-- which is GC'd for terminal runs older than 7 days; provenance resting on that
-- file alone would evaporate exactly when a post-hoc question is asked. It is
-- deliberately NOT folded into `runs.runner_snapshot`, which resume/recover
-- reads and which must stay runner identity only.
ALTER TABLE "agent_project_links" ADD COLUMN "memory_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_memory_hash" text;
