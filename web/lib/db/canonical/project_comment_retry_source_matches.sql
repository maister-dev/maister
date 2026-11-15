CREATE OR REPLACE FUNCTION public.project_comment_retry_source_matches(source_id text, requester_id text, appointment jsonb)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs source
    JOIN agent_trigger_attempts invocation ON invocation.id=appointment->>'attemptId'
      AND invocation.reserved_run_id=source.id AND invocation.run_id=source.id
    JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
    JOIN domain_events event ON event.id=source.trigger_event_id AND event.id=invocation.trigger_event_id
    JOIN task_comments comment ON comment.id=event.payload->>'commentId'
      AND comment.project_id=source.project_id AND comment.task_id=source.task_id
    WHERE source.id=source_id AND source.retry_of_run_id IS NULL AND source.project_id IS NOT NULL
      AND source.company_id IS NULL AND source.trigger_source='domain_event' AND source.scheduled_request_snapshot IS NULL
      AND appointment=jsonb_build_object('schemaVersion',1,'kind','task_comment','runId',source.id,
        'attemptId',invocation.id,'scheduleId',schedule.id,'eventId',event.id)
      AND invocation.project_id=source.project_id AND invocation.company_id IS NULL
      AND invocation.source_agent_id=source.source_agent_id AND invocation.trigger_source='domain_event'
      AND invocation.provenance='claim' AND invocation.outcome IN ('queued','launched','deduplicated')
      AND invocation.scheduled_request_snapshot IS NULL
      AND invocation.binding_snapshot=jsonb_build_object('version',1,'scheduleId',schedule.id,'triggerType','mention',
        'cronExpr',schedule.cron_expr,'timezone',schedule.timezone,'eventKinds',coalesce(schedule.event_match->'kinds','[]'::jsonb))
      AND schedule.project_id=source.project_id AND schedule.company_id IS NULL
      AND schedule.enabled AND schedule.trigger_type='mention' AND schedule.agent_id=source.source_agent_id
      AND event.project_id=source.project_id AND event.company_id IS NULL AND event.kind='task.comment_added'
      AND event.task_id=source.task_id AND event.actor_type='user' AND event.actor_id=requester_id
      AND event.payload->'mentionedAgentIds' ? source.source_agent_id
      AND comment.actor_type='user' AND comment.actor_id=requester_id
      AND source.trigger_payload=jsonb_build_object('kind','task.comment_added','payload',jsonb_build_object('commentId',comment.id))
    FOR SHARE OF invocation,schedule,event,comment
  )
$function$;
