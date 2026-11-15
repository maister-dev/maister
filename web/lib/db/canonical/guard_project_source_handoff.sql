CREATE OR REPLACE FUNCTION public.guard_project_source_handoff()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE head specialist_assignments%ROWTYPE;
DECLARE input specialist_input_revisions%ROWTYPE;
DECLARE source jsonb;
BEGIN
  IF TG_OP='UPDATE' AND OLD.specialist_assignment IS NOT NULL THEN
    IF NEW.specialist_assignment IS DISTINCT FROM OLD.specialist_assignment THEN
      RAISE EXCEPTION 'Project source handoff identity and original input are immutable'
        USING ERRCODE='23514',CONSTRAINT='project_source_handoff_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.specialist_assignment IS NULL THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' OR (OLD.outcome IS NOT NULL AND OLD.outcome<>'unknown') OR OLD.run_id IS NOT NULL
    OR OLD.original_run_id IS NOT NULL
    OR NEW.outcome IS DISTINCT FROM 'queued' OR NEW.run_id IS NOT NULL
    OR NEW.original_run_id IS NOT NULL OR NEW.settled_at IS NULL
    OR NEW.reason_code IS NOT NULL OR NEW.project_id IS NULL OR NEW.company_id IS NOT NULL
    OR NEW.provenance<>'claim' THEN
    RAISE EXCEPTION 'Project source handoff requires its open unused invocation and atomic queued acknowledgement'
      USING ERRCODE='23514',CONSTRAINT='project_source_handoff_reservation';
  END IF;
  source:=NEW.specialist_assignment->'source';
  IF source->>'attemptId' IS DISTINCT FROM NEW.id
    OR source->>'scheduleId' IS DISTINCT FROM NEW.schedule_id
    OR source->>'runId' IS DISTINCT FROM NEW.reserved_run_id
    OR NOT ((NEW.trigger_source='cron' AND NEW.trigger_event_id IS NULL AND source->>'kind'='cron')
      OR (NEW.trigger_source='domain_event' AND source->>'kind' IN ('task_comment','event')
        AND source->'eventId'=to_jsonb(NEW.trigger_event_id))) IS TRUE
    OR EXISTS(SELECT 1 FROM runs WHERE id=NEW.reserved_run_id)
    OR EXISTS(SELECT 1 FROM task_launch_intents
      WHERE settings_snapshot->'serverExecution'->'execution'->'agentTriggerReservation'->>'attemptId'=NEW.id) THEN
    RAISE EXCEPTION 'Project source handoff must retain its exact unallocated source reservation'
      USING ERRCODE='23514',CONSTRAINT='project_source_handoff_reference';
  END IF;
  SELECT * INTO head FROM specialist_assignments
    WHERE id=NEW.specialist_assignment->'assignment'->>'id' FOR SHARE;
  SELECT * INTO input FROM specialist_input_revisions
    WHERE assignment_id=head.id AND to_jsonb(revision)=NEW.specialist_assignment->'assignment'->'inputRevision' FOR SHARE;
  IF head.id IS NULL OR input.assignment_id IS NULL OR head.project_id IS DISTINCT FROM NEW.project_id
    OR head.company_id IS NOT NULL OR head.status<>'queued' OR head.project_task_id IS NULL
    OR head.responsible->>'id' IS DISTINCT FROM NEW.source_agent_id
    OR EXISTS(SELECT 1 FROM specialist_run_links link WHERE link.assignment_id=head.id)
    OR EXISTS(SELECT 1 FROM task_launch_intents intent WHERE intent.task_id=head.project_task_id)
    OR head.input_revision IS DISTINCT FROM input.revision
    OR input.digest IS DISTINCT FROM NEW.specialist_assignment->'assignment'->>'inputSha256'
    OR input.standing_definition->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR input.actor IS DISTINCT FROM head.requester
    OR NOT EXISTS(SELECT 1 FROM specialist_intake_receipts receipt
      WHERE receipt.assignment_id=head.id AND receipt.input_revision=input.revision AND receipt.actor=input.actor)
    OR NOT EXISTS(SELECT 1 FROM tasks task WHERE task.id=head.project_task_id AND task.project_id=head.project_id
      AND task.qualification_source_version='specialist-assignment:v1:'||head.id||':'||input.revision::text||':'||input.digest)
    OR NOT ((source->>'kind'='cron' AND head.origin=jsonb_build_object('kind','schedule','scheduleId',NEW.schedule_id,'triggerAttemptId',NEW.id))
      OR (source->>'kind'='event' AND head.origin=jsonb_build_object('kind','event','eventId',NEW.trigger_event_id::text,'subscriptionId',NEW.schedule_id))
      OR (source->>'kind'='task_comment' AND head.origin->>'kind'='task_comment'
        AND head.origin->>'projectId'=NEW.project_id AND EXISTS(SELECT 1 FROM domain_events event
          WHERE event.id=NEW.trigger_event_id AND event.project_id=NEW.project_id
            AND event.kind='task.comment_added' AND event.task_id=head.origin->>'taskId'
            AND event.payload->>'commentId'=head.origin->>'commentId'
            AND event.actor_type='user' AND event.actor_id=head.requester->>'id'))) IS TRUE THEN
    RAISE EXCEPTION 'Project source handoff requires its original attributed assignment, intake and exact carrier input'
      USING ERRCODE='23514',CONSTRAINT='project_source_handoff_assignment';
  END IF;
  RETURN NEW;
END $function$;
