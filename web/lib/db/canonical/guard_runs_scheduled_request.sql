CREATE OR REPLACE FUNCTION public.guard_runs_scheduled_request()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.scheduled_request_snapshot IS DISTINCT FROM OLD.scheduled_request_snapshot THEN
    RAISE EXCEPTION 'scheduled request input is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='runs_scheduled_request_immutable';
  END IF;
  RETURN NEW;
END $function$;
