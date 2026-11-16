CREATE OR REPLACE FUNCTION public.guard_agent_retry_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.retry_of_run_id IS NOT NULL AND NEW.retry_of_run_id IS DISTINCT FROM OLD.retry_of_run_id THEN
    RAISE EXCEPTION 'retry lineage is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_agent_retry_lineage_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
