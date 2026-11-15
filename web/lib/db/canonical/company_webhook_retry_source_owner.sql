CREATE OR REPLACE FUNCTION public.company_webhook_retry_source_owner(source_id text, requester_id text)
 RETURNS text
 LANGUAGE sql
AS $function$
  SELECT subject.company_id FROM runs source
  JOIN specialist_run_links appointment ON appointment.run_id=source.id AND appointment.work_id IS NULL
  JOIN specialist_assignments subject ON subject.id=appointment.assignment_id AND subject.company_id=source.company_id
  JOIN specialist_intake_receipts receipt ON receipt.assignment_id=subject.id
    AND receipt.input_revision=appointment.input_revision AND receipt.source_kind='webhook'
  JOIN company_grants authority ON authority.company_id=subject.company_id AND authority.principal_type='user'
    AND authority.principal_id=requester_id AND authority.action='assignments:submit' AND authority.revoked_at IS NULL
  WHERE source.id=source_id AND source.company_id IS NOT NULL AND source.project_id IS NULL
    AND source.retry_of_run_id IS NULL AND source.trigger_source='webhook'
    AND source.trigger_event_id IS NULL AND source.agent_schedule_id IS NULL
    AND source.agent_chain_depth=0 AND source.scheduled_request_snapshot IS NULL
    AND source.created_by_user_id=requester_id AND subject.origin->>'kind'='webhook'
    AND receipt.actor->>'kind'='user' AND receipt.actor->>'id'=requester_id
    AND receipt.source_key=task_launch_admission_digest(jsonb_build_object(
      'schemaVersion',1,'owner',jsonb_build_object('kind','company','companyId',subject.company_id),'origin',subject.origin))
  FOR SHARE OF receipt,authority
$function$;
