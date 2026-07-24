-- ADR-150 (Phase 5, T5.1): drop the legacy Experiment tables. The idempotent
-- backfill re-runs first as a zero-cost safety valve — a no-op on empty tables,
-- but it converts any surviving legacy Experiment into an evaluation Study
-- (preserving `legacy_snapshot`) before the tables and the function are dropped,
-- satisfying the preserve-or-refuse-loudly migration rule. `evaluation_studies.
-- legacy_experiment_id` + `legacy_snapshot` columns stay for historical provenance.
SELECT evaluation_backfill_from_experiments();--> statement-breakpoint
DROP TABLE "experiment_runs" CASCADE;--> statement-breakpoint
DROP TABLE "experiments" CASCADE;--> statement-breakpoint
DROP FUNCTION evaluation_backfill_from_experiments();
