CREATE OR REPLACE FUNCTION public.guard_agent_activity_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.source_agent_id IS NOT NULL AND
     ROW(NEW.source_agent_id, NEW.launched_at, NEW.activity_sort_at,
         NEW.activity_timestamp_provenance, NEW.agent_activity_snapshot)
       IS DISTINCT FROM
     ROW(OLD.source_agent_id, OLD.launched_at, OLD.activity_sort_at,
         OLD.activity_timestamp_provenance, OLD.agent_activity_snapshot) THEN
    RAISE EXCEPTION 'agent activity snapshot is immutable for run %', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'runs_agent_activity_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
