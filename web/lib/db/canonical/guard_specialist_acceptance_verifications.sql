CREATE OR REPLACE FUNCTION public.guard_specialist_acceptance_verifications()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM run_results result WHERE result.id=NEW.result_id
      AND specialist_acceptance_verification_ids(result.value)=NEW.verification_ids
  ) THEN
    RAISE EXCEPTION 'Assignment acceptance requires the exact published verification IDs'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_verification_required';
  END IF;
  RETURN NEW;
END;
$function$;
