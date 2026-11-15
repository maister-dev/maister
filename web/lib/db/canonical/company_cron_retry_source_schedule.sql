CREATE OR REPLACE FUNCTION public.company_cron_retry_source_schedule(source_id text, requester_id text)
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT schedule.id FROM agent_schedules schedule
  JOIN agent_trigger_attempts invocation ON invocation.schedule_id=schedule.id
  JOIN runs source ON source.id=source_id AND source.id=invocation.run_id
  WHERE invocation.id=source.scheduled_request_snapshot->>'triggerAttemptId'
    AND schedule.id=source.agent_schedule_id AND schedule.id=source.scheduled_request_snapshot->>'scheduleId'
    AND schedule.company_id=source.company_id AND schedule.project_id IS NULL
    AND schedule.enabled AND schedule.trigger_type='cron' AND schedule.created_by=requester_id
    AND source.trigger_source='cron' AND source.trigger_event_id IS NULL AND source.agent_chain_depth=0
    AND invocation.company_id=schedule.company_id AND invocation.project_id IS NULL
    AND invocation.trigger_source='cron' AND invocation.reserved_run_id=source.id
    AND invocation.outcome IN ('queued','launched')
    AND invocation.scheduled_request_snapshot=source.scheduled_request_snapshot
    AND invocation.binding_snapshot->'sourceRevision'=to_jsonb(schedule.company_config_revision)
    AND invocation.binding_snapshot->'specialistBinding'=source.company_execution_snapshot->'specialistBinding'
    AND invocation.binding_snapshot->'coordinatorFlowBinding' IS NOT DISTINCT FROM
      coalesce(source.company_execution_snapshot->'coordinatorFlowBinding','null'::jsonb)
  FOR SHARE OF schedule,invocation
$function$;
