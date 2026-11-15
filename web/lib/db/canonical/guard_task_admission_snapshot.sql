CREATE OR REPLACE FUNCTION public.guard_task_admission_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot OR OLD.task_qualification_snapshot IS DISTINCT FROM NEW.task_qualification_snapshot THEN RAISE EXCEPTION 'task admission snapshot is immutable' USING ERRCODE='23514',CONSTRAINT='runs_task_admission_immutable'; END IF;
  IF OLD.task_qualification_snapshot IS NOT NULL AND ROW(NEW.project_id,NEW.task_id,NEW.source_agent_id) IS DISTINCT FROM ROW(OLD.project_id,OLD.task_id,OLD.source_agent_id) THEN RAISE EXCEPTION 'qualifier run provenance is immutable' USING ERRCODE='23514',CONSTRAINT='runs_qualification_provenance_immutable'; END IF;
  RETURN NEW;
END $function$;
