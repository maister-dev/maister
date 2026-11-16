CREATE OR REPLACE FUNCTION public.retain_active_qualification_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM task_qualifications q JOIN tasks t ON t.current_qualification_id=q.id WHERE q.original_run_id=OLD.id) THEN
    RAISE EXCEPTION 'run is retained as current task qualification evidence' USING ERRCODE='23514',CONSTRAINT='task_qualification_active_evidence_retained';
  END IF;
  RETURN OLD;
END $function$;
