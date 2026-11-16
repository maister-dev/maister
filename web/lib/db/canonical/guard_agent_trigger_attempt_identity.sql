CREATE OR REPLACE FUNCTION public.guard_agent_trigger_attempt_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW.project_id, NEW.company_id, NEW.source_agent_id, NEW.schedule_id, NEW.binding_snapshot,
         NEW.fence, NEW.delivery_key, NEW.trigger_source, NEW.trigger_event_id,
         NEW.provenance, NEW.reserved_run_id, NEW.claimed_at, NEW.scheduled_request_snapshot)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.company_id, OLD.source_agent_id, OLD.schedule_id, OLD.binding_snapshot,
         OLD.fence, OLD.delivery_key, OLD.trigger_source, OLD.trigger_event_id,
         OLD.provenance, OLD.reserved_run_id, OLD.claimed_at, OLD.scheduled_request_snapshot) THEN
    RAISE EXCEPTION 'agent trigger attempt identity is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_identity_immutable';
  END IF;
  IF OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown' AND
     ROW(NEW.outcome, NEW.settled_at, NEW.original_run_id, NEW.reason_code)
       IS DISTINCT FROM ROW(OLD.outcome, OLD.settled_at, OLD.original_run_id, OLD.reason_code) THEN
    IF NOT (OLD.company_id IS NULL AND NEW.company_id IS NULL AND OLD.outcome='queued' AND NEW.outcome='queued'
      AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at AND NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code
      AND OLD.run_id IS NULL AND OLD.original_run_id IS NULL
      AND NEW.run_id=OLD.reserved_run_id AND NEW.original_run_id=OLD.reserved_run_id
      AND EXISTS(SELECT 1 FROM runs linked JOIN task_launch_intents intent ON intent.id=linked.task_launch_intent_id
        WHERE linked.id=OLD.reserved_run_id AND linked.project_id=OLD.project_id AND linked.source_agent_id=OLD.source_agent_id
          AND intent.run_id=linked.id AND intent.original_run_id=linked.id AND intent.state='run_bound'
          AND intent.project_id=linked.project_id AND intent.task_id=linked.task_id
          AND intent.principal_kind='system'
          AND intent.settings_snapshot->'serverExecution'->>'kind'='agent_trigger'
          AND intent.principal_id='agent_trigger:'||(intent.settings_snapshot->'serverExecution'->>'id')
          AND intent.settings_snapshot->'serverExecution'->'execution'->'agentTriggerReservation'->>'attemptId'=OLD.id
          AND intent.settings_snapshot->'serverExecution'->'execution'->'agentTriggerReservation'->>'runId'=OLD.reserved_run_id
          AND linked.scheduled_request_snapshot IS NOT DISTINCT FROM OLD.scheduled_request_snapshot)) IS TRUE THEN
      RAISE EXCEPTION 'settled agent trigger attempt is immutable for %', OLD.id
        USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_settlement_immutable';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
