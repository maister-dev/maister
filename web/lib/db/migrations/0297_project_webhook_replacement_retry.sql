CREATE FUNCTION project_webhook_retry_receipt(source_id text, requester_id text)
RETURNS text LANGUAGE sql VOLATILE AS $$
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_project_specialist_replacement_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.recipe->'version' IS DISTINCT FROM '2'::jsonb
       OR NEW.recipe->>'strategy' IS DISTINCT FROM 'pre_work_retry'
       OR coalesce(NEW.recipe->'trigger'->>'source','') NOT IN ('manual','cron','domain_event','webhook')
       OR NEW.actor_user_id IS NULL OR NEW.actor_identity <> 'user:' || NEW.actor_user_id
       OR NEW.state <> 'accepted' OR NEW.created_run_id IS NOT NULL
       OR NOT EXISTS (
      SELECT 1 FROM runs source
      JOIN specialist_run_links link ON link.run_id=source.id AND link.work_id IS NULL
      JOIN specialist_assignments subject ON subject.id=link.assignment_id AND subject.project_id=source.project_id
      JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=subject.input_revision
      JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id AND owner.placement_id=source.execution_assignment_id
      JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
      WHERE source.id=NEW.source_run_id AND source.project_id=NEW.project_id
        AND source.source_agent_id=NEW.source_agent_id AND source.run_kind='agent' AND source.agent_kind='operational'
        AND source.parent_run_id IS NULL AND NOT source.persistent AND source.workspace_mode IS DISTINCT FROM 'shared'
        AND ((source.agent_workspace='none' AND NOT (witness ? 'worktree'))
          OR (source.agent_workspace='worktree' AND witness->'worktree'=project_worktree_retry_source(source.id)))
        AND NEW.recipe->'taskId'=coalesce(to_jsonb(source.task_id),'null'::jsonb)
        AND source.trigger_source=NEW.recipe->'trigger'->>'source'
        AND (
          (source.task_id IS NULL AND source.trigger_source='manual' AND subject.origin->>'kind'='manual'
            AND source.agent_schedule_id IS NULL AND source.scheduled_request_snapshot IS NULL AND source.trigger_event_id IS NULL AND NOT (witness ?| ARRAY['cron','event','comment','webhook']))
          OR (source.task_id IS NULL AND source.trigger_source='webhook' AND subject.origin->>'kind'='webhook'
            AND NOT (witness ?| ARRAY['cron','event','comment'])
            AND NEW.recipe->'trigger'->'eventId'='null'::jsonb
            AND NEW.recipe->'trigger'->'payload'=source.trigger_payload
            AND witness->>'webhook'=project_webhook_retry_receipt(source.id,NEW.actor_user_id))
          OR (source.task_id IS NULL AND source.trigger_source='cron' AND subject.origin->>'kind'='schedule'
            AND subject.origin->>'scheduleId'=witness->'cron'->>'scheduleId'
            AND subject.origin->>'triggerAttemptId'=witness->'cron'->>'attemptId'
            AND source.scheduled_request_snapshot=NEW.recipe->'scheduledRequestSnapshot'
            AND NOT (witness ?| ARRAY['event','comment','webhook'])
            AND project_cron_retry_source_matches(source.id,NEW.actor_user_id,witness->'cron'))
          OR (source.task_id IS NULL AND source.trigger_source='domain_event' AND subject.origin->>'kind'='event'
            AND NOT (witness ?| ARRAY['cron','comment','webhook'])
            AND subject.origin->>'subscriptionId'=witness->'event'->>'scheduleId'
            AND subject.origin->>'eventId'=witness->'event'->>'eventId'
            AND NEW.recipe->'trigger'->'eventId'=to_jsonb(source.trigger_event_id)
            AND NEW.recipe->'trigger'->'payload'=source.trigger_payload
            AND project_event_retry_source_matches(source.id,NEW.actor_user_id,witness->'event'))
          OR (source.task_id IS NOT NULL AND source.trigger_source='domain_event' AND subject.origin->>'kind'='task_comment'
            AND NOT (witness ?| ARRAY['cron','event','webhook'])
            AND subject.origin->>'taskId'=source.task_id
            AND subject.origin->>'commentId'=source.trigger_payload->'payload'->>'commentId'
            AND NEW.recipe->'trigger'->'eventId'=to_jsonb(source.trigger_event_id)
            AND NEW.recipe->'trigger'->'payload'=source.trigger_payload
            AND project_comment_retry_source_matches(source.id,NEW.actor_user_id,witness->'comment')
            AND EXISTS (SELECT 1 FROM task_comments comment WHERE comment.id=subject.origin->>'commentId'
              AND comment.body=input.objective_input->>'input' FOR SHARE))
        )
        AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.result_contract IS NOT NULL AND source.operational_terminal IS NOT NULL
        AND subject.status='active'
        AND subject.requester->>'kind'='user' AND subject.requester->>'id'=NEW.actor_user_id
        AND link.role IN ('specialist','continuation') AND link.input_revision=input.revision
        AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND source.knowledge_access->>'state'='complete'
        AND source.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
          'kind','assignment_input','assignmentId',subject.id,'inputRevision',input.revision,'inputSha256',input.digest))
        AND witness-ARRAY['cron','event','comment','webhook','worktree']=jsonb_build_object('sourceRunId',source.id,'assignmentId',subject.id,
          'inputRevision',input.revision,'inputSha256',input.digest,'assignmentRevision',subject.revision,
          'contextRevision',subject.context_revision,'ownerEpoch',owner.epoch,
          'resultSha256',task_launch_admission_digest(source.result_contract),'sourceSha256',company_retry_source_digest(source))
        AND NEW.recipe->'runner'=session.runner_snapshot AND NEW.selected_runner_id=session.runner_id
        AND company_retry_has_dispatch_witness(source.id)
        AND NOT EXISTS(SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id AND placement.state='active')
        AND NOT EXISTS(SELECT 1 FROM run_sessions bound WHERE bound.run_id=source.id AND bound.acp_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=source.id AND incarnation.state IN ('created','active'))
        AND NOT EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=source.id
          AND (command.kind IN ('session.prompt','session.steer') OR (command.kind='session.create'
            AND (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
              AND command.receipt_evidence->>'inflight'='false') IS NOT TRUE)))
    ) THEN
      RAISE EXCEPTION 'Project replacement retry requires the exact settled source and native assignment'
        USING ERRCODE='23514', CONSTRAINT='project_specialist_replacement_reference';
    END IF;
  ELSIF NEW.state='launched' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS (
    SELECT 1 FROM runs successor JOIN runs source ON source.id=successor.retry_of_run_id
    JOIN specialist_run_links link ON link.run_id=successor.id
    JOIN run_sessions session ON session.run_id=successor.id AND session.session_name='default'
    WHERE successor.id=NEW.created_run_id AND successor.id=NEW.successor_run_id
      AND successor.project_id=NEW.project_id AND source.id=NEW.source_run_id
      AND successor.status='Pending' AND successor.parent_run_id IS NULL AND successor.task_id IS NOT DISTINCT FROM source.task_id
      AND successor.source_agent_id=NEW.source_agent_id AND successor.created_by_user_id=NEW.actor_user_id
      AND successor.trigger_source=source.trigger_source
      AND successor.trigger_event_id IS NOT DISTINCT FROM source.trigger_event_id
      AND successor.trigger_payload IS NOT DISTINCT FROM source.trigger_payload
      AND successor.agent_chain_depth=source.agent_chain_depth
      AND successor.agent_schedule_id IS NOT DISTINCT FROM source.agent_schedule_id
      AND successor.scheduled_request_snapshot IS NOT DISTINCT FROM source.scheduled_request_snapshot
      AND successor.agent_workspace=source.agent_workspace
      AND (NOT (witness ? 'worktree') OR EXISTS (
        SELECT 1 FROM workspaces workspace WHERE workspace.run_id=successor.id
          AND workspace.project_id=successor.project_id
          AND workspace.base_commit=witness->'worktree'->>'baseCommit'
          AND workspace.base_branch=witness->'worktree'->>'baseBranch'
          AND task_launch_admission_digest(to_jsonb(workspace.parent_repo_path))=witness->'worktree'->>'repositorySha256'
        FOR SHARE))
      AND successor.result_contract=source.result_contract AND successor.knowledge_access=source.knowledge_access
      AND link.role='continuation' AND link.work_id IS NULL AND link.assignment_id=witness->>'assignmentId'
      AND to_jsonb(link.input_revision)=witness->'inputRevision' AND session.runner_snapshot=NEW.recipe->'runner'
  ) THEN
    RAISE EXCEPTION 'Project replacement retry must reserve the exact successor before settling its receipt'
      USING ERRCODE='23514', CONSTRAINT='project_specialist_replacement_successor';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
