-- Both JSON operands require parentheses: json extraction and containment share operator precedence.
CREATE OR REPLACE FUNCTION guard_operational_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
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
       (SELECT coalesce(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
          FROM jsonb_array_elements(NEW.operational_integrity_baseline->'platform') WITH ORDINALITY AS entries(item, ordinal)
          WHERE ordinal <= jsonb_array_length(OLD.operational_integrity_baseline->'platform'))
         IS DISTINCT FROM (OLD.operational_integrity_baseline->'platform') THEN
      RAISE EXCEPTION 'operational baseline source is immutable and generations are append-only'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_operational_baseline_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
