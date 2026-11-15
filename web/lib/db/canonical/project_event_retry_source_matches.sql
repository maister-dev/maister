CREATE OR REPLACE FUNCTION public.project_event_retry_source_matches(source_id text, requester_id text, appointment jsonb)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs source
    JOIN agent_trigger_attempts invocation ON invocation.id=appointment->>'attemptId'
      AND invocation.reserved_run_id=source.id AND invocation.run_id=source.id
    JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
    JOIN domain_events fact ON fact.id=source.trigger_event_id AND fact.id=invocation.trigger_event_id
    WHERE source.id=source_id AND source.retry_of_run_id IS NULL AND source.project_id IS NOT NULL
      AND source.company_id IS NULL AND source.trigger_source='domain_event' AND source.scheduled_request_snapshot IS NULL
      AND appointment=jsonb_build_object('schemaVersion',1,'kind','event','runId',source.id,
        'attemptId',invocation.id,'scheduleId',schedule.id,'eventId',fact.id)
      AND invocation.project_id=source.project_id AND invocation.company_id IS NULL
      AND invocation.source_agent_id=source.source_agent_id AND invocation.trigger_source='domain_event'
      AND invocation.provenance='claim' AND invocation.outcome IN ('queued','launched','deduplicated')
      AND invocation.binding_snapshot->'review'=schedule.project_source_review
      AND invocation.binding_snapshot->'eventKinds'=schedule.event_match->'kinds'
      AND invocation.binding_snapshot->'eventKinds' ? fact.kind
      AND schedule.project_id=source.project_id AND schedule.company_id IS NULL
      AND schedule.enabled AND schedule.trigger_type='event' AND schedule.agent_id=source.source_agent_id
      AND schedule.project_source_review->>'reviewerUserId'=requester_id
      AND fact.project_id=source.project_id AND fact.company_id IS NULL
      AND (fact.run_id IS NULL OR schedule.project_source_review->>'sourceSharing'='producing_run')
    FOR SHARE OF invocation,schedule,fact
  )
$function$;
