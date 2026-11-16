CREATE OR REPLACE FUNCTION public.brain_check_submission_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE proposal_project text; proposal_company text;
BEGIN
  SELECT project_id,company_id INTO proposal_project,proposal_company FROM brain_proposals WHERE id=NEW.proposal_id;
  IF FOUND AND (proposal_project IS DISTINCT FROM NEW.project_id OR proposal_company IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'Submission and proposal must have the same lifetime owner' USING ERRCODE='23514', CONSTRAINT='brain_submission_owner_check';
  END IF;
  RETURN NEW;
END $function$;
