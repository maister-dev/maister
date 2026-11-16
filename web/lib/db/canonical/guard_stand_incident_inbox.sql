CREATE OR REPLACE FUNCTION public.guard_stand_incident_inbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.stand_incident_id IS NOT NULL OR NEW.stand_incident_id IS NOT NULL) THEN
    IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN
      RAISE EXCEPTION 'Stand incident Inbox routing and evidence are immutable'
        USING ERRCODE='23514',CONSTRAINT='stand_incident_inbox_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stand_incident_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM stand_incident_episodes episode
    LEFT JOIN stand_verifications recovery ON recovery.id=episode.recovery_verification_id
    JOIN stand_operations operation ON operation.id=CASE NEW.event_kind
      WHEN 'stand_incident_opened' THEN episode.first_operation_id
      WHEN 'stand_incident_resolved' THEN recovery.operation_id END
      AND operation.resource_key=episode.resource_key
    JOIN specialist_assignments subject ON subject.id=operation.assignment_id
    WHERE episode.id=NEW.stand_incident_id
      AND ((NEW.event_kind='stand_incident_opened' AND episode.state='open')
        OR (NEW.event_kind='stand_incident_resolved' AND episode.state='resolved' AND recovery.state='healthy'))
      AND subject.requester->>'kind'='user' AND subject.requester->>'id'=NEW.recipient_id
      AND subject.company_id IS NOT DISTINCT FROM NEW.company_id AND subject.project_id IS NOT DISTINCT FROM NEW.project_id
      AND NEW.source_ref=jsonb_build_object('kind','stand_incident',
        'incidentId',episode.id,'operationId',operation.id,'assignmentId',subject.id)
  ) THEN
    RAISE EXCEPTION 'Stand incident Inbox requires the exact transition and assignment requester'
      USING ERRCODE='23514',CONSTRAINT='stand_incident_inbox_reference';
  END IF;
  RETURN NEW;
END
$function$;
