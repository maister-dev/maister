CREATE OR REPLACE FUNCTION public.check_specialist_cancellation_run_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  candidate_run_id text;
  subject_id text;
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    candidate_run_id := NEW.id;
  ELSE
    candidate_run_id := NEW.run_id;
  END IF;
  SELECT assignment_id INTO subject_id FROM specialist_run_links WHERE run_id=candidate_run_id;
  IF FOUND THEN
    PERFORM require_no_pending_specialist_cancellation(subject_id);
  END IF;
  RETURN NEW;
END
$function$;
