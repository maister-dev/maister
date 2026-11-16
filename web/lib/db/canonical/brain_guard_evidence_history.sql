CREATE OR REPLACE FUNCTION public.brain_guard_evidence_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE source_project text; source_company text;
BEGIN
  IF TG_TABLE_NAME='brain_evidence_observations' THEN
    source_project := OLD.project_id;
    source_company := OLD.company_id;
  ELSE
    SELECT project_id,company_id INTO source_project,source_company FROM brain_evidence_observations WHERE id=OLD.observation_id;
    IF TG_OP='DELETE' AND NOT FOUND THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP='DELETE' AND source_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=source_project) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Evidence captures are immutable' USING ERRCODE='23514', CONSTRAINT='brain_evidence_history_immutable';
END $function$;
