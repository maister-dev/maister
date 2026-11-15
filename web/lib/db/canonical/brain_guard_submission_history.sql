CREATE OR REPLACE FUNCTION public.brain_guard_submission_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' AND OLD.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Knowledge submission identity is immutable' USING ERRCODE='23514', CONSTRAINT='brain_submission_immutable';
END $function$;
