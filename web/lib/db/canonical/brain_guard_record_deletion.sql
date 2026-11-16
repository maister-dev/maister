CREATE OR REPLACE FUNCTION public.brain_guard_record_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Withdraw a knowledge record or delete its owning project; direct history removal is forbidden' USING ERRCODE='23514', CONSTRAINT='brain_record_delete_requires_project_cascade';
END $function$;
