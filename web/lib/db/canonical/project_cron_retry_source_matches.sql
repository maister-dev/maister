CREATE OR REPLACE FUNCTION public.project_cron_retry_source_matches(source_id text, requester_id text, appointment jsonb)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs source
    JOIN agent_trigger_attempts invocation ON invocation.id=appointment->>'attemptId'
      AND invocation.reserved_run_id=source.id AND invocation.run_id=source.id
    JOIN agent_schedules schedule ON schedule.id=invocation.schedule_id AND schedule.id=source.agent_schedule_id
    WHERE source.id=source_id AND source.retry_of_run_id IS NULL AND source.project_id IS NOT NULL
      AND source.company_id IS NULL AND source.trigger_source='cron' AND source.trigger_event_id IS NULL
      AND appointment=jsonb_build_object('schemaVersion',1,'kind','cron','runId',source.id,
        'attemptId',invocation.id,'scheduleId',schedule.id)
      AND invocation.project_id=source.project_id AND invocation.company_id IS NULL
      AND invocation.source_agent_id=source.source_agent_id AND invocation.trigger_source='cron'
      AND invocation.provenance='claim' AND invocation.outcome IN ('queued','launched','deduplicated')
      AND invocation.scheduled_request_snapshot=source.scheduled_request_snapshot
      AND schedule.project_id=source.project_id AND schedule.company_id IS NULL
      AND schedule.enabled AND schedule.trigger_type='cron' AND schedule.agent_id=source.source_agent_id
      AND schedule.request_at_launch=source.scheduled_request_snapshot->>'requestAtLaunch'
      AND invocation.binding_snapshot->>'cronExpr'=schedule.cron_expr
      AND invocation.binding_snapshot->>'timezone'=schedule.timezone
      AND invocation.binding_snapshot->'review'=schedule.project_source_review
      AND schedule.project_source_review->>'reviewerUserId'=requester_id
    FOR SHARE OF invocation,schedule
  )
$function$;
