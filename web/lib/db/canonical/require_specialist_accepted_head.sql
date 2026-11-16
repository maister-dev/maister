CREATE OR REPLACE FUNCTION public.require_specialist_accepted_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments subject
    WHERE subject.id=NEW.assignment_id AND subject.acceptance_id=NEW.id
      AND subject.status='completed' AND subject.revision=NEW.expected_revision+1
      AND EXISTS (
        SELECT 1 FROM domain_events event
        WHERE event.kind='specialist.assignment_changed'
          AND event.payload->>'assignmentId'=subject.id
          AND event.payload->'revision'=to_jsonb(subject.revision)
          AND event.payload->>'status'='completed' AND event.payload->>'cause'='acceptance'
      )
  ) THEN
    RAISE EXCEPTION 'Final acceptance and completed assignment must commit together'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_completed_head_required';
  END IF;
  RETURN NEW;
END $function$;
