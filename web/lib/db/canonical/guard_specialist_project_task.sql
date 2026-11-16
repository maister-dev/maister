CREATE OR REPLACE FUNCTION public.guard_specialist_project_task()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND OLD.project_task_id IS NOT NULL AND NEW.project_task_id IS DISTINCT FROM OLD.project_task_id THEN
    RAISE EXCEPTION 'The original project assignment task is immutable; continuations retain separate existing work/run links'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_project_task_immutable';
  END IF;
  IF NEW.project_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks task WHERE task.id=NEW.project_task_id AND task.project_id=NEW.project_id AND NEW.company_id IS NULL FOR SHARE
  ) THEN
    RAISE EXCEPTION 'The initial assignment task must belong to its explicit project owner'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_project_task_reference';
  END IF;
  RETURN NEW;
END;
$function$;
