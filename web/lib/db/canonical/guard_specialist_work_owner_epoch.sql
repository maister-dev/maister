CREATE OR REPLACE FUNCTION public.guard_specialist_work_owner_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF specialist_execution_owner_epoch(NEW.parent_run_id)=-1 THEN
    RAISE EXCEPTION 'Delegation requires the current specialist executor lease'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_owner_epoch_required';
  END IF;
  RETURN NEW;
END $function$;
