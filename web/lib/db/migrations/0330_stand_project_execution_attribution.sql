CREATE OR REPLACE FUNCTION guard_stand_operation_execution_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.initiating_execution IS NULL THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.initiating_execution)<>'object'
    OR NOT (NEW.initiating_execution ?& ARRAY['agentId','runId','nodeAttemptId'])
    OR NEW.initiating_execution-ARRAY['agentId','runId','nodeAttemptId']<>'{}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM runs execution
      JOIN specialist_run_links link ON link.run_id=execution.id AND link.assignment_id=NEW.assignment_id
      JOIN specialist_assignments subject ON subject.id=link.assignment_id
      JOIN specialist_input_revisions original ON original.assignment_id=link.assignment_id
        AND original.revision=link.input_revision
      JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id
        AND input.revision=NEW.input_revision AND input.digest=NEW.input_sha256
      JOIN stand_targets target ON target.id=NEW.target_id
      WHERE execution.id=NEW.initiating_execution->>'runId' AND execution.status='Running'
        AND input.objective_input->'targetIds' ? target.id
        AND (
          (execution.company_id=target.company_id AND subject.company_id=execution.company_id
            AND execution.created_by_user_id=NEW.initiating_user_id)
          OR (execution.project_id=subject.project_id AND original.actor->>'kind'='user'
            AND original.actor->>'id'=NEW.initiating_user_id
            AND EXISTS (
              SELECT 1 FROM agent_project_links binding
              JOIN agents professional ON professional.id=binding.agent_id
              WHERE binding.project_id=execution.project_id AND binding.enabled AND professional.enabled
                AND professional.quarantined_at IS NULL
                AND professional.id=NEW.initiating_execution->>'agentId'
                AND professional.specialist->'targetClasses' ? 'stand'
            )
            AND EXISTS (
              SELECT 1 FROM company_grants authority WHERE authority.company_id=target.company_id
                AND authority.principal_type='agent'
                AND authority.principal_id=NEW.initiating_execution->>'agentId'
                AND authority.action='targets:read' AND authority.revoked_at IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM company_grants authority WHERE authority.company_id=target.company_id
                AND authority.principal_type='agent'
                AND authority.principal_id=NEW.initiating_execution->>'agentId'
                AND authority.action=CASE NEW.action WHEN 'restart' THEN 'targets:restart'
                  WHEN 'logs' THEN 'targets:logs' ELSE 'targets:read' END AND authority.revoked_at IS NULL
            ))
        )
        AND specialist_run_has_input(execution.id,link.assignment_id,NEW.input_revision,NEW.input_sha256)
        AND specialist_execution_owner_epoch(execution.id)>0
        AND (
          (execution.run_kind='agent' AND execution.agent_id=NEW.initiating_execution->>'agentId'
            AND NEW.initiating_execution->'nodeAttemptId'='null'::jsonb)
          OR (execution.run_kind='flow' AND EXISTS (
            SELECT 1 FROM node_attempts node WHERE node.id=NEW.initiating_execution->>'nodeAttemptId'
              AND node.run_id=execution.id AND node.knowledge_actor->>'agentId'=NEW.initiating_execution->>'agentId'
          ))
        )
    )
  THEN
    RAISE EXCEPTION 'Stand intent attribution requires its exact current execution and input' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
