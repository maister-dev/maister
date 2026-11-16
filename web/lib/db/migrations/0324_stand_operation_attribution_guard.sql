CREATE FUNCTION guard_stand_operation_execution_actor() RETURNS trigger LANGUAGE plpgsql AS $$
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
      JOIN stand_targets target ON target.id=NEW.target_id AND target.company_id=execution.company_id
      WHERE execution.id=NEW.initiating_execution->>'runId'
        AND execution.created_by_user_id=NEW.initiating_user_id AND execution.status='Running'
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
--> statement-breakpoint
CREATE TRIGGER stand_operation_execution_actor_guard BEFORE INSERT ON stand_operations
FOR EACH ROW EXECUTE FUNCTION guard_stand_operation_execution_actor();
