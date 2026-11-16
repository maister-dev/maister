CREATE OR REPLACE FUNCTION public.appoint_specialist_executor_on_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM appoint_specialist_executor(NEW.run_id);
  RETURN NEW;
END $function$;
