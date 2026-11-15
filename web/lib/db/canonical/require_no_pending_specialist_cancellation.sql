CREATE OR REPLACE FUNCTION public.require_no_pending_specialist_cancellation(subject_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The intent and business writes serialize on the assignment head. NOWAIT
  -- lets a Run/placement-first caller unwind instead of reversing lock order.
  PERFORM 1 FROM specialist_assignments WHERE id=subject_id FOR SHARE NOWAIT;
  IF specialist_assignment_cancellation_pending(subject_id) THEN
    RAISE EXCEPTION 'Assignment cancellation already owns settlement'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignment_cancellation_pending';
  END IF;
END
$function$;
