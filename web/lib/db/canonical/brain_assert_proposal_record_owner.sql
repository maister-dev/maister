CREATE OR REPLACE FUNCTION public.brain_assert_proposal_record_owner(record_identity text, proposal_project text, proposal_company text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE record_project text; record_company text;
BEGIN
  SELECT project_id,company_id INTO record_project,record_company FROM brain_items WHERE id=record_identity;
  IF FOUND AND (record_project IS DISTINCT FROM proposal_project OR record_company IS DISTINCT FROM proposal_company) THEN
    RAISE EXCEPTION 'Proposal and accepted record must have the same lifetime owner' USING ERRCODE='23514', CONSTRAINT='brain_proposal_record_owner_check';
  END IF;
END $function$;
