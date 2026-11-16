CREATE OR REPLACE FUNCTION public.validate_operational_terminal_result()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;
