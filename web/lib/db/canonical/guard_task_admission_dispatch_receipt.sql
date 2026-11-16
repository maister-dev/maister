CREATE OR REPLACE FUNCTION public.guard_task_admission_dispatch_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.task_admission_checked_at IS NOT NULL AND OLD.task_admission_checked_at IS DISTINCT FROM NEW.task_admission_checked_at
    OR NEW.task_admission_checked_at IS NOT NULL AND NEW.task_admission_snapshot IS NULL THEN
    RAISE EXCEPTION 'first task dispatch receipt is write-once and requires its frozen admission'
      USING ERRCODE='23514',CONSTRAINT='runs_task_dispatch_receipt_immutable';
  END IF;
  RETURN NEW;
END $function$;
