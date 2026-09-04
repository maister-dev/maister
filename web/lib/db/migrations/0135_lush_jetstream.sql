DO $$
DECLARE
  unresolved_run_id text;
BEGIN
  SELECT id INTO unresolved_run_id
  FROM runs r
  WHERE r.execution_data_plane_mode = 'legacy_file_v1'
    AND (
      SELECT count(*)
      FROM execution_data_plane_imports i
      WHERE i.run_id = r.id
        AND i.source_kind IN ('events', 'transcript', 'cost', 'runtime_objects', 'scratch_session')
        AND i.state = 'complete'
        AND i.source_fingerprint IS NOT NULL
        AND i.last_source_position IS NOT NULL
        AND i.started_at IS NOT NULL
        AND i.completed_at IS NOT NULL
        AND i.attempts > 0
        AND i.last_error IS NULL
    ) <> 5
  LIMIT 1;

  IF unresolved_run_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage B cutover cannot begin: run % lacks five complete preservation proof records. Run `pnpm --filter maister-web execution-data-plane:import-legacy` against the legacy runtime mount and resolve any reported preservation failure before retrying migration.',
      unresolved_run_id;
  END IF;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "runs_execution_data_plane_mode_immutable" ON "runs";--> statement-breakpoint
DROP FUNCTION IF EXISTS maister_runs_execution_data_plane_mode_immutable();--> statement-breakpoint
UPDATE "runs"
SET "execution_data_plane_mode" = 'canonical_events_v1'
WHERE "execution_data_plane_mode" = 'legacy_file_v1';--> statement-breakpoint
DROP TABLE "artifact_projection_cursors" CASCADE;
