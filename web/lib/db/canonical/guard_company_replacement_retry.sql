CREATE OR REPLACE FUNCTION public.guard_company_replacement_retry()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'accepted' OR NEW.created_run_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM runs source
      JOIN specialist_run_links link ON link.run_id=source.id
      JOIN specialist_assignments subject ON subject.id=link.assignment_id
      JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id
        AND owner.placement_id=source.execution_assignment_id
      LEFT JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
      WHERE source.id=NEW.source_run_id AND source.company_id=NEW.company_id
        AND source.source_agent_id=NEW.source_agent_id
        AND source.parent_run_id IS NULL AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.agent_workspace='none'
        AND source.trigger_source=NEW.recipe->'trigger'->>'source'
        AND (
          (source.trigger_source='manual' AND source.agent_schedule_id IS NULL)
          OR (source.trigger_source='cron' AND source.retry_of_run_id IS NULL
            AND source.scheduled_request_snapshot=NEW.recipe->'scheduledRequestSnapshot'
            AND company_cron_retry_source_schedule(source.id,NEW.actor_user_id)=source.agent_schedule_id)
          OR (source.trigger_source='domain_event' AND source.retry_of_run_id IS NULL
            AND NEW.recipe->'trigger'->'eventId'=to_jsonb(source.trigger_event_id)
            AND EXISTS(SELECT 1 FROM company_event_retry_source(source.id,NEW.actor_user_id)))
          OR (source.trigger_source='webhook' AND source.retry_of_run_id IS NULL
            AND company_webhook_retry_source_owner(source.id,NEW.actor_user_id)=source.company_id)
        )
        AND source.result_contract IS NOT NULL
        AND (
          (source.run_kind='agent' AND source.operational_terminal IS NOT NULL
            AND NOT (witness ? 'sessionsSha256') AND NEW.recipe->'coordinatorFlowBinding'='null'::jsonb
            AND NEW.recipe->'runner'=session.runner_snapshot AND company_retry_has_dispatch_witness(source.id))
          OR (source.run_kind='flow' AND source.operational_terminal IS NULL
            AND NEW.recipe->'coordinatorFlowBinding'=source.company_execution_snapshot->'coordinatorFlowBinding'
            AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(source.id)
            AND company_flow_retry_has_dispatch_witness(source.id)
            AND EXISTS (SELECT 1 FROM run_sessions slot WHERE slot.run_id=source.id
              AND slot.runner_snapshot=NEW.recipe->'runner' AND slot.runner_id=NEW.selected_runner_id))
        )
        AND link.assignment_id=NEW.recipe->'assignment'->>'id'
        AND subject.status='active' AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND witness->'sourceRunId'=to_jsonb(source.id)
        AND witness->'ownerEpoch'=to_jsonb(owner.epoch)
        AND witness->'contextRevision'=to_jsonb(subject.context_revision)
        AND witness->'assignmentRevision'=to_jsonb(subject.revision)
        AND witness->>'resultSha256'=task_launch_admission_digest(source.result_contract)
        AND witness->>'sourceSha256'=company_retry_source_digest(source)
        AND NOT EXISTS(SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id AND placement.state='active')
        AND NOT EXISTS(SELECT 1 FROM run_sessions bound WHERE bound.run_id=source.id AND bound.acp_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=source.id AND incarnation.state IN ('created','active'))
        AND NOT EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=source.id
          AND (command.kind IN ('session.prompt','session.steer') OR (command.kind='session.create'
            AND (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
              AND command.receipt_evidence->>'inflight'='false') IS NOT TRUE)))
    ) THEN
      RAISE EXCEPTION 'Replacement retry requires the exact settled specialist Run and current owner'
        USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_reference';
    END IF;
  ELSIF NEW.state='launched' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS (
    SELECT 1 FROM runs source JOIN runs successor ON successor.id=NEW.created_run_id
    JOIN specialist_run_links link ON link.run_id=successor.id
    LEFT JOIN run_sessions session ON session.run_id=successor.id AND session.session_name='default'
    WHERE source.id=NEW.source_run_id AND successor.id=NEW.successor_run_id
      AND successor.company_id=NEW.company_id AND successor.parent_run_id IS NULL
      AND successor.status='Pending' AND successor.retry_of_run_id=source.id AND link.work_id IS NULL
      AND ((source.run_kind='agent' AND successor.run_kind='agent' AND link.role='continuation'
        AND session.runner_snapshot=NEW.recipe->'runner')
        OR (source.run_kind='flow' AND successor.run_kind='flow' AND link.role='coordinator'
          AND successor.company_execution_snapshot->'coordinatorFlowBinding'=NEW.recipe->'coordinatorFlowBinding'
          AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(successor.id)))
      AND link.assignment_id=NEW.recipe->'assignment'->>'id'
      AND successor.company_execution_snapshot->'assignment'=NEW.recipe->'assignment'
      AND successor.company_execution_snapshot->'specialistBinding'=NEW.recipe->'specialistBinding'
      AND successor.trigger_source=source.trigger_source
      AND successor.trigger_event_id IS NOT DISTINCT FROM source.trigger_event_id
      AND successor.agent_chain_depth=source.agent_chain_depth
      AND successor.agent_schedule_id IS NOT DISTINCT FROM source.agent_schedule_id
      AND successor.scheduled_request_snapshot IS NOT DISTINCT FROM source.scheduled_request_snapshot
      AND successor.result_contract=source.result_contract
      AND successor.knowledge_access=source.knowledge_access
  ) THEN
    RAISE EXCEPTION 'Replacement retry must reserve the exact successor before settling its receipt'
      USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_successor';
  END IF;
  RETURN NEW;
END $function$;
