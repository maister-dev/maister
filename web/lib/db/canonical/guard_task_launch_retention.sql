CREATE OR REPLACE FUNCTION public.guard_task_launch_retention()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.state IN ('queued','preparing','run_bound','held') THEN
    RAISE EXCEPTION 'Active launch authority must be cancelled or settled before retention'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_active_retention';
  END IF;
  RETURN OLD;
END $function$;
