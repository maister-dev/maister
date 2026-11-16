CREATE OR REPLACE FUNCTION public.appoint_specialist_executor_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM appoint_specialist_executor(NEW.id);
  RETURN NEW;
END $function$;
