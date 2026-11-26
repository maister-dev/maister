CREATE OR REPLACE FUNCTION public.guard_task_launch_host_selection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(OLD.requested_execution_host_id, OLD.effective_execution_host_id,
         OLD.execution_host_provenance, OLD.execution_host_eligibility_revision)
     IS DISTINCT FROM
     ROW(NEW.requested_execution_host_id, NEW.effective_execution_host_id,
         NEW.execution_host_provenance, NEW.execution_host_eligibility_revision) THEN
    RAISE EXCEPTION 'Accepted execution host selection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'task_launch_intents_host_selection_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
