CREATE OR REPLACE FUNCTION public.project_webhook_retry_receipt(source_id text, requester_id text)
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT receipt.id FROM runs source
  JOIN specialist_run_links appointment ON appointment.run_id=source.id AND appointment.work_id IS NULL
  JOIN specialist_assignments subject ON subject.id=appointment.assignment_id AND subject.project_id=source.project_id
  JOIN specialist_intake_receipts receipt ON receipt.assignment_id=subject.id
    AND receipt.input_revision=appointment.input_revision AND receipt.source_kind='webhook' AND receipt.disposition='created'
  WHERE source.id=source_id AND source.project_id IS NOT NULL AND source.company_id IS NULL AND source.task_id IS NULL
    AND source.retry_of_run_id IS NULL AND source.trigger_source='webhook'
    AND source.trigger_event_id IS NULL AND source.agent_schedule_id IS NULL
    AND source.agent_chain_depth=0 AND source.scheduled_request_snapshot IS NULL
    AND source.created_by_user_id=requester_id AND subject.origin->>'kind'='webhook'
    AND source.trigger_payload=jsonb_build_object('schemaVersion',1,'origin',subject.origin)
    AND subject.origin->>'endpointId'=task_launch_admission_digest(jsonb_build_object('schemaVersion',1,
      'kind','project_agent_webhook','projectId',source.project_id,'userId',requester_id,'agentId',source.source_agent_id))
    AND receipt.actor->>'kind'='user' AND receipt.actor->>'id'=requester_id
    AND receipt.source_key=task_launch_admission_digest(jsonb_build_object(
      'schemaVersion',1,'owner',jsonb_build_object('kind','project','projectId',source.project_id),'origin',subject.origin))
  FOR SHARE OF receipt
$function$;
