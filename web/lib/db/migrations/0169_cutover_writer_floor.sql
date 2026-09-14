-- S4.7 / D9 step 10: the cut-over writer floor. Unchanged 0135 proved every
-- preservation lane ONCE, at cut-over time; this migration makes that proof a
-- permanent invariant and closes the table to writers that predate it.
--
-- A `complete` record recorded without its proof is exactly the false proof the
-- 0135 preflight exists to refuse. It is left untouched and named: re-prove it
-- with the import CLI against retained sources, or repair it explicitly. Never
-- relabel, never drop.
DO $$
DECLARE
  unproven bigint;
BEGIN
  SELECT count(*) INTO unproven FROM execution_data_plane_imports
  WHERE state = 'complete'
    AND (source_fingerprint IS NULL OR last_source_position IS NULL
      OR started_at IS NULL OR completed_at IS NULL
      OR attempts <= 0 OR last_error IS NOT NULL);

  IF unproven > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '55006',
      MESSAGE = 'cutover writer floor refused: ' || unproven ||
        ' complete lane record(s) without proof',
      DETAIL = 'A complete preservation lane must carry the fingerprint, position, timestamps and clean error the cut-over preflight required. These rows are left exactly as they are.',
      HINT = 'select run_id, source_kind from execution_data_plane_imports where state = ''complete'' and (source_fingerprint is null or last_source_position is null or started_at is null or completed_at is null or attempts <= 0 or last_error is not null)';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "execution_data_plane_imports" ADD CONSTRAINT "execution_data_plane_imports_complete_proof_check" CHECK ("execution_data_plane_imports"."state" <> 'complete' OR ("execution_data_plane_imports"."source_fingerprint" IS NOT NULL AND "execution_data_plane_imports"."last_source_position" IS NOT NULL AND "execution_data_plane_imports"."started_at" IS NOT NULL AND "execution_data_plane_imports"."completed_at" IS NOT NULL AND "execution_data_plane_imports"."attempts" > 0 AND "execution_data_plane_imports"."last_error" IS NULL));--> statement-breakpoint
-- The writer gate. A binary that carries this floor declares the capability on
-- its session (web client, migrator and import CLI do so on connect); an older
-- binary never does and is refused by the class it presents, never trusted by
-- default.
CREATE FUNCTION "maister_execution_data_plane_imports_writer_gate"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  declared text := coalesce(
    nullif(current_setting('maister.writer_capability', true), ''),
    'undeclared');
BEGIN
  IF declared <> 'execution-ab-1' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      CONSTRAINT = 'execution_data_plane_imports_writer_gate',
      MESSAGE = 'execution_data_plane_imports refuses writer_class=' || declared ||
        ' below schema floor execution-ab-1',
      DETAIL = 'Only a session that declares the execution-ab-1 writer capability may write a preservation lane record after the cut-over; an older writer cannot create or reopen a proof.',
      HINT = 'Deploy a binary that carries migration 0169; its web client, migrator and import CLI declare the capability on connect.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "execution_data_plane_imports_writer_gate"
BEFORE INSERT OR UPDATE ON "execution_data_plane_imports"
FOR EACH ROW EXECUTE FUNCTION "maister_execution_data_plane_imports_writer_gate"();--> statement-breakpoint
-- A proven lane is final: its state, fingerprint, position and count cannot
-- move. Operational counters and timestamps still can.
CREATE FUNCTION "maister_execution_data_plane_imports_complete_is_final"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'complete' AND
    ROW(NEW.state, NEW.source_fingerprint, NEW.last_source_position, NEW.imported_count)
    IS DISTINCT FROM
    ROW(OLD.state, OLD.source_fingerprint, OLD.last_source_position, OLD.imported_count)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'execution_data_plane_imports_complete_is_final',
      MESSAGE = 'a proven preservation lane record is final',
      DETAIL = 'run ' || OLD.run_id || ' lane ' || OLD.source_kind ||
        ' is complete; its state, fingerprint, position and count cannot change.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "execution_data_plane_imports_complete_is_final"
BEFORE UPDATE OF state, source_fingerprint, last_source_position, imported_count
ON "execution_data_plane_imports"
FOR EACH ROW EXECUTE FUNCTION "maister_execution_data_plane_imports_complete_is_final"();
