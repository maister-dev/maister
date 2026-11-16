CREATE FUNCTION guard_project_specialist_replacement_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.recipe->'version' IS DISTINCT FROM '2'::jsonb
       OR NEW.recipe->>'strategy' IS DISTINCT FROM 'pre_work_retry'
       OR NEW.recipe->'taskId' IS DISTINCT FROM 'null'::jsonb
       OR NEW.recipe->'trigger'->>'source' IS DISTINCT FROM 'manual'
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
        AND source.parent_run_id IS NULL AND source.task_id IS NULL AND source.agent_workspace='none' AND NOT source.persistent
        AND source.trigger_source='manual' AND source.trigger_event_id IS NULL AND source.agent_schedule_id IS NULL
        AND source.scheduled_request_snapshot IS NULL AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.result_contract IS NOT NULL AND source.operational_terminal IS NOT NULL
        AND subject.status='active' AND subject.origin->>'kind'='manual'
        AND subject.requester->>'kind'='user' AND subject.requester->>'id'=NEW.actor_user_id
        AND link.role IN ('specialist','continuation') AND link.input_revision=input.revision
        AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND source.knowledge_access->>'state'='complete'
        AND source.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
          'kind','assignment_input','assignmentId',subject.id,'inputRevision',input.revision,'inputSha256',input.digest))
        AND witness=jsonb_build_object('sourceRunId',source.id,'assignmentId',subject.id,
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
      AND successor.status='Pending' AND successor.parent_run_id IS NULL AND successor.task_id IS NULL
      AND successor.source_agent_id=NEW.source_agent_id AND successor.created_by_user_id=NEW.actor_user_id
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
CREATE TRIGGER project_specialist_replacement_guard BEFORE INSERT OR UPDATE ON agent_retry_intents
FOR EACH ROW WHEN (NEW.project_id IS NOT NULL AND NEW.recipe ? 'replacement')
EXECUTE FUNCTION guard_project_specialist_replacement_retry();
