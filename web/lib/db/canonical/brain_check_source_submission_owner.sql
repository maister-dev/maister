CREATE OR REPLACE FUNCTION public.brain_check_source_submission_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE witness_project text; witness_company text; witness_source text;
BEGIN
  SELECT o.project_id,o.company_id,o.source_id INTO witness_project,witness_company,witness_source FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id WHERE w.id=NEW.witness_id;
  IF FOUND AND (witness_project IS DISTINCT FROM NEW.project_id OR witness_company IS DISTINCT FROM NEW.company_id OR witness_source IS DISTINCT FROM NEW.source_id) THEN
    RAISE EXCEPTION 'Source submission and capture must have the same lifetime owner and source' USING ERRCODE='23514', CONSTRAINT='brain_source_submission_owner_check';
  END IF;
  RETURN NEW;
END $function$;
