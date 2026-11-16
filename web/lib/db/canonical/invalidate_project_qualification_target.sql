CREATE OR REPLACE FUNCTION public.invalidate_project_qualification_target()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.main_branch IS DISTINCT FROM OLD.main_branch THEN UPDATE tasks SET qualification_input_revision=qualification_input_revision+1 WHERE project_id=NEW.id AND qualification_mode<>'legacy' AND (base_branch IS NULL OR target_branch IS NULL); END IF;
  RETURN NEW;
END $function$;
