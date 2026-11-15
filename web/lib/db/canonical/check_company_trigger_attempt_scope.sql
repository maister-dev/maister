CREATE OR REPLACE FUNCTION public.check_company_trigger_attempt_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE source agent_schedules;
BEGIN
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO source FROM agent_schedules WHERE id=NEW.schedule_id;
  IF source.id IS NULL OR source.project_id IS NOT NULL OR source.company_id IS DISTINCT FROM NEW.company_id OR source.agent_id IS DISTINCT FROM NEW.source_agent_id OR source.last_attempt_fence IS DISTINCT FROM NEW.fence OR
     NEW.binding_snapshot->>'triggerType' IS DISTINCT FROM source.trigger_type OR
     (NEW.binding_snapshot->>'sourceRevision')::numeric IS DISTINCT FROM source.company_config_revision::numeric OR
     NEW.binding_snapshot->'specialistBinding'->>'id' IS DISTINCT FROM source.company_specialist_binding_id OR
     NEW.binding_snapshot->'coordinatorFlowBinding'->>'id' IS DISTINCT FROM source.company_flow_binding_id OR
     NEW.binding_snapshot->>'cronExpr' IS DISTINCT FROM source.cron_expr OR
     NEW.binding_snapshot->>'timezone' IS DISTINCT FROM source.timezone OR
     NEW.binding_snapshot->'eventKinds' IS DISTINCT FROM COALESCE(source.event_match->'kinds','[]'::jsonb) OR
     (source.trigger_type='cron') IS DISTINCT FROM (NEW.trigger_source='cron') OR
     (source.trigger_type='cron') IS DISTINCT FROM (NEW.trigger_event_id IS NULL) THEN
    RAISE EXCEPTION 'Company invocation must preserve its exact source identity and configuration' USING ERRCODE='23514';
  END IF;
  IF source.trigger_type='cron' AND (NEW.scheduled_request_snapshot IS NULL OR NEW.scheduled_request_snapshot->>'requestAtLaunch' IS DISTINCT FROM source.request_at_launch) THEN
    RAISE EXCEPTION 'Company cron invocation must retain its actual version-one request input' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM company_specialist_binding_revisions r JOIN company_specialist_bindings b ON b.id=r.binding_id
    WHERE b.id=source.company_specialist_binding_id AND b.company_id=NEW.company_id AND b.agent_id=NEW.source_agent_id
      AND r.revision::numeric=(NEW.binding_snapshot->'specialistBinding'->>'revision')::numeric
      AND r.snapshot_digest=NEW.binding_snapshot->'specialistBinding'->>'snapshotSha256') THEN
    RAISE EXCEPTION 'Company invocation professional configuration witness is unavailable' USING ERRCODE='23514';
  END IF;
  IF source.company_flow_binding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_flow_binding_revisions r JOIN company_flow_bindings b ON b.id=r.binding_id
    WHERE b.id=source.company_flow_binding_id AND b.company_id=NEW.company_id
      AND r.revision::numeric=(NEW.binding_snapshot->'coordinatorFlowBinding'->>'revision')::numeric
      AND r.snapshot_digest=NEW.binding_snapshot->'coordinatorFlowBinding'->>'snapshotSha256') THEN
    RAISE EXCEPTION 'Company invocation coordinator configuration witness is unavailable' USING ERRCODE='23514';
  END IF;
  IF NEW.trigger_source='domain_event' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.id=NEW.trigger_event_id AND e.company_id=NEW.company_id AND e.project_id IS NULL) THEN
    RAISE EXCEPTION 'Company invocation event must have the same explicit owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
