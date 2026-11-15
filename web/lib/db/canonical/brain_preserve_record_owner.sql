CREATE OR REPLACE FUNCTION public.brain_preserve_record_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Knowledge ownership is immutable' USING ERRCODE='23514', CONSTRAINT='brain_record_owner_immutable';
  END IF;
  RETURN NEW;
END $function$;
