CREATE OR REPLACE FUNCTION public.specialist_assignment_cancellation_pending(subject_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM specialist_assignment_control_receipts
    WHERE assignment_id=subject_id AND next_attempt_at IS NOT NULL
  )
$function$;
