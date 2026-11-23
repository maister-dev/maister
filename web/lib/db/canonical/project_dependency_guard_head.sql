CREATE OR REPLACE FUNCTION public.project_dependency_guard_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.kind,NEW.logical_id,NEW.ordinal)
     IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.kind,OLD.logical_id,OLD.ordinal)
     OR NEW.generation NOT BETWEEN OLD.generation AND OLD.generation + 1
     OR (NEW.desired <> OLD.desired AND NEW.generation = OLD.generation) THEN
    RAISE EXCEPTION 'Invalid project dependency generation or identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
