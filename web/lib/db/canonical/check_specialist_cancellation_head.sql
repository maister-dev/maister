CREATE OR REPLACE FUNCTION public.check_specialist_cancellation_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status<>'cancelled' AND specialist_assignment_cancellation_pending(NEW.id) THEN
    RAISE EXCEPTION 'Assignment cancellation already owns settlement'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignment_cancellation_pending';
  END IF;
  RETURN NEW;
END
$function$;
