CREATE OR REPLACE FUNCTION public.project_dependency_guard_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF project_dependency_safe_source(NEW.desired->>'source') IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid dependency source for project %', NEW.project_id USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
