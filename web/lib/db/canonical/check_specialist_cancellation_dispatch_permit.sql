CREATE OR REPLACE FUNCTION public.check_specialist_cancellation_dispatch_permit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE subject_id text;
BEGIN
  SELECT assignment_id INTO subject_id FROM stand_operations WHERE id=NEW.operation_id;
  IF FOUND THEN
    PERFORM require_no_pending_specialist_cancellation(subject_id);
  END IF;
  RETURN NEW;
END
$function$;
