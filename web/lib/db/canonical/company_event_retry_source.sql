CREATE OR REPLACE FUNCTION public.company_event_retry_source(source_id text, requester_id text)
 RETURNS TABLE(schedule_id text, event_id bigint, chain_depth integer, producing_run_id text)
 LANGUAGE sql
AS $function$
  SELECT schedule.id,event.id,source.agent_chain_depth,producing.id
  FROM runs source
  JOIN agent_trigger_attempts invocation ON invocation.reserved_run_id=source.id AND invocation.run_id=source.id
  JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
  JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.id=source.trigger_event_id
  JOIN runs producing ON producing.id=event.run_id AND producing.company_id=source.company_id AND producing.project_id IS NULL
  JOIN company_grants sharing ON sharing.company_id=source.company_id AND sharing.principal_type='agent'
    AND sharing.principal_id=source.source_agent_id AND sharing.action='assignments:read' AND sharing.revoked_at IS NULL
  WHERE source.id=source_id AND source.trigger_source='domain_event' AND source.retry_of_run_id IS NULL
    AND source.company_id IS NOT NULL AND source.project_id IS NULL AND source.scheduled_request_snapshot IS NULL
    AND schedule.company_id=source.company_id AND schedule.project_id IS NULL AND schedule.enabled
    AND schedule.trigger_type='event' AND schedule.created_by=requester_id
    AND invocation.company_id=source.company_id AND invocation.project_id IS NULL
    AND invocation.trigger_source='domain_event' AND invocation.outcome IN ('queued','launched','deduplicated')
    AND invocation.binding_snapshot->'sourceRevision'=to_jsonb(schedule.company_config_revision)
    AND invocation.binding_snapshot->'specialistBinding'=source.company_execution_snapshot->'specialistBinding'
    AND invocation.binding_snapshot->'coordinatorFlowBinding' IS NOT DISTINCT FROM
      coalesce(source.company_execution_snapshot->'coordinatorFlowBinding','null'::jsonb)
    AND invocation.binding_snapshot->'eventKinds' ? event.kind
    AND event.company_id=source.company_id AND event.project_id IS NULL
    AND producing.knowledge_access->>'state'='complete'
  FOR SHARE OF invocation,schedule,event,producing,sharing
$function$;
