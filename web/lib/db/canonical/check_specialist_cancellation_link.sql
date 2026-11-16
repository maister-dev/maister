CREATE OR REPLACE FUNCTION public.check_specialist_cancellation_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM require_no_pending_specialist_cancellation(NEW.assignment_id);
  RETURN NEW;
END
$function$;
