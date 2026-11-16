CREATE OR REPLACE FUNCTION public.check_company_cancellation_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.company_cancellation_intent IS NOT NULL AND NEW.company_cancellation_intent IS DISTINCT FROM OLD.company_cancellation_intent THEN
    RAISE EXCEPTION 'Company cancellation intent is immutable' USING ERRCODE='23514', CONSTRAINT='runs_company_cancellation_immutable';
  END IF;
  IF NEW.company_cancellation_intent IS NOT NULL AND NEW.status IN ('Done','Failed') THEN
    RAISE EXCEPTION 'Company cancellation must settle before result completion' USING ERRCODE='23514', CONSTRAINT='runs_company_cancellation_pending';
  END IF;
  RETURN NEW;
END $function$;
