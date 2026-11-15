CREATE OR REPLACE FUNCTION public.brain_check_proposal_record_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE reference_id text; proposal_project text; proposal_company text;
BEGIN
  IF TG_TABLE_NAME='brain_proposals' THEN
    FOREACH reference_id IN ARRAY ARRAY[NEW.target_record_id,NEW.published_record_id] LOOP
      IF reference_id IS NOT NULL THEN PERFORM brain_assert_proposal_record_owner(reference_id,NEW.project_id,NEW.company_id); END IF;
    END LOOP;
  ELSIF NEW.proposal_id IS NOT NULL THEN
    SELECT project_id,company_id INTO proposal_project,proposal_company FROM brain_proposals WHERE id=NEW.proposal_id;
    IF FOUND THEN PERFORM brain_assert_proposal_record_owner(NEW.record_id,proposal_project,proposal_company); END IF;
  END IF;
  RETURN NEW;
END $function$;
