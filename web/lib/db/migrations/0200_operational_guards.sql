-- Operational semantics are fixed when a run is admitted, including Pending.
CREATE FUNCTION guard_operational_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.agent_kind = 'operational' OR NEW.agent_kind = 'operational') AND
     (OLD.agent_kind IS DISTINCT FROM NEW.agent_kind OR
      OLD.result_contract IS DISTINCT FROM NEW.result_contract OR
      OLD.agent_workspace IS DISTINCT FROM NEW.agent_workspace OR
      OLD.workspace_mode IS DISTINCT FROM NEW.workspace_mode OR
      OLD.persistent IS DISTINCT FROM NEW.persistent) THEN
    RAISE EXCEPTION 'operational launch snapshot is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_snapshot_immutable';
  END IF;
  IF OLD.operational_terminal IS NOT NULL AND OLD.operational_terminal IS DISTINCT FROM NEW.operational_terminal THEN
    RAISE EXCEPTION 'operational terminal receipt is write-once'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_terminal_immutable';
  END IF;
  IF OLD.operational_integrity_baseline IS NOT NULL AND OLD.operational_integrity_baseline IS DISTINCT FROM NEW.operational_integrity_baseline THEN
    IF NEW.operational_integrity_baseline IS NOT NULL AND NOT (
      jsonb_typeof(NEW.operational_integrity_baseline->'generation') = 'number' AND
      NEW.operational_integrity_baseline->>'generation' ~ '^[0-9]{1,9}$'
    ) IS TRUE THEN
      RAISE EXCEPTION 'invalid operational baseline generation'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_baseline_check';
    END IF;
    IF NEW.operational_integrity_baseline IS NULL OR
       (OLD.operational_integrity_baseline - ARRAY['generation','platform','indexDigest']) IS DISTINCT FROM
       (NEW.operational_integrity_baseline - ARRAY['generation','platform','indexDigest']) OR
       (NEW.operational_integrity_baseline->>'generation')::bigint <> (OLD.operational_integrity_baseline->>'generation')::bigint + 1 OR
       NOT (NEW.operational_integrity_baseline->'platform' @> OLD.operational_integrity_baseline->'platform') THEN
      RAISE EXCEPTION 'operational baseline source is immutable and generations are append-only'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_baseline_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_operational_snapshot_guard BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION guard_operational_run_snapshot();
--> statement-breakpoint
-- This is deferred so result publication and the terminal receipt share one tx.
CREATE FUNCTION validate_operational_terminal_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id text;
  candidate runs%ROWTYPE;
  published run_results%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    target_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_id := OLD.run_id;
  ELSE
    target_id := NEW.run_id;
  END IF;
  SELECT * INTO candidate FROM runs WHERE id = target_id;
  IF NOT FOUND OR candidate.agent_kind IS DISTINCT FROM 'operational' OR candidate.operational_terminal IS NULL THEN
    RETURN NULL;
  END IF;
  IF candidate.operational_terminal->'resultRevision' <> 'null'::jsonb THEN
    SELECT * INTO published FROM run_results WHERE run_id = target_id
      AND revision::text = candidate.operational_terminal->>'resultRevision';
    IF NOT FOUND OR published.schema_sha256 IS DISTINCT FROM candidate.result_contract->>'sha256' OR
       published.schema_ref IS DISTINCT FROM candidate.result_contract->>'schemaRef' OR
       (candidate.operational_terminal->>'validation' = 'valid' AND published.validity <> 'valid') OR
       (candidate.operational_terminal->>'validation' = 'invalid' AND published.validity <> 'invalid') OR
       (candidate.operational_terminal->>'successful' = 'true' AND published.value->>'outcome' IS DISTINCT FROM 'success') THEN
      RAISE EXCEPTION 'operational terminal receipt requires its exact validated result revision'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_result_receipt_check';
    END IF;
  ELSIF candidate.operational_terminal->>'validation' IN ('valid','invalid') THEN
    RAISE EXCEPTION 'validated operational receipt requires resultRevision'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_result_receipt_check';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER runs_operational_result_receipt
AFTER INSERT OR UPDATE ON runs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operational_terminal_result();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER run_results_operational_receipt
AFTER INSERT OR UPDATE OR DELETE ON run_results DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operational_terminal_result();
--> statement-breakpoint
CREATE FUNCTION check_operational_run_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt jsonb := NEW.operational_terminal;
  cleanup jsonb := NEW.operational_cleanup;
  baseline jsonb := NEW.operational_integrity_baseline;
BEGIN
  IF NEW.agent_kind IS DISTINCT FROM 'operational' THEN RETURN NEW; END IF;
  IF baseline IS NOT NULL AND NOT (
    jsonb_typeof(baseline) = 'object' AND baseline ?& ARRAY['version','generation','resourceKind','capturedAt','head','branch','indexDigest','source','platform'] AND
    baseline->>'generation' ~ '^[0-9]{1,9}$' AND jsonb_typeof(baseline->'generation') = 'number' AND
    baseline->>'resourceKind' IN ('worktree','ephemeral_checkout','plain_directory','shared_repository') AND
    pg_input_is_valid(baseline->>'capturedAt', 'timestamp with time zone')
  ) IS TRUE THEN
    RAISE EXCEPTION 'invalid operational integrity baseline' USING ERRCODE='23514', CONSTRAINT='runs_operational_baseline_check';
  END IF;
  IF receipt IS NOT NULL THEN
    IF NOT (receipt ?& ARRAY['version','status','cause','effectiveOutcome','successful','validation','integrity','baselineGeneration','resultRevision','reasonCodes','evidenceIds'] AND
      length(receipt->>'cause') BETWEEN 1 AND 256 AND
      (receipt->'resultRevision' = 'null'::jsonb OR jsonb_typeof(receipt->'resultRevision') = 'number' AND receipt->>'resultRevision' ~ '^[1-9][0-9]{0,8}$') AND
      CASE NEW.status
        WHEN 'Done' THEN receipt->>'effectiveOutcome' = 'success'
        WHEN 'Failed' THEN receipt->>'effectiveOutcome' IN ('partial','blocked','failed')
        WHEN 'Crashed' THEN receipt->>'effectiveOutcome' = 'crashed'
        WHEN 'Abandoned' THEN receipt->>'effectiveOutcome' = 'cancelled'
        ELSE false
      END) IS TRUE THEN
      RAISE EXCEPTION 'invalid operational terminal decision' USING ERRCODE='23514', CONSTRAINT='runs_operational_terminal_check';
    END IF;
  END IF;
  IF cleanup IS NOT NULL THEN
    IF NOT (cleanup ?& ARRAY['version','resourceKind','workspace','state','revision','armedAt','attempts','dueAt','errorCode','evidenceIds','removedAt','releasedAt','lease','rearmReceipt'] AND
      NEW.status IN ('Done','Failed','Crashed','Abandoned') AND
      pg_input_is_valid(cleanup->>'armedAt', 'timestamp with time zone') AND
      (cleanup->'dueAt' = 'null'::jsonb OR pg_input_is_valid(cleanup->>'dueAt', 'timestamp with time zone')) AND
      (cleanup->>'resourceKind' <> 'worktree' OR cleanup->'lease' = 'null'::jsonb) AND
      (cleanup->'lease' = 'null'::jsonb OR
        length(cleanup->'lease'->>'id') > 0 AND length(cleanup->'lease'->>'owner') > 0 AND pg_input_is_valid(cleanup->'lease'->>'expiresAt', 'timestamp with time zone'))
    ) IS TRUE THEN
      RAISE EXCEPTION 'invalid operational cleanup intent' USING ERRCODE='23514', CONSTRAINT='runs_operational_cleanup_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_operational_state_guard BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION check_operational_run_state();
