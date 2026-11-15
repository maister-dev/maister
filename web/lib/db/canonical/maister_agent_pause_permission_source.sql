CREATE OR REPLACE FUNCTION public.maister_agent_pause_permission_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind = 'permission' AND OLD.superseded_at IS NOT NULL THEN
    IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.run_id IS DISTINCT FROM OLD.run_id
      OR NEW.schema IS DISTINCT FROM OLD.schema
      OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
      OR NEW.superseded_by_hitl_request_id IS DISTINCT FROM OLD.superseded_by_hitl_request_id THEN
      RAISE EXCEPTION 'superseded agent permission source is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'hitl_requests_agent_pause_permission_source';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'permission' AND NEW.superseded_at IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM hitl_requests pause
      JOIN execution_commands command ON command.id = NEW.schema->'agentPrompt'->>'commandId'
      WHERE pause.id = NEW.superseded_by_hitl_request_id AND pause.run_id = NEW.run_id
        AND pause.kind IN ('hook_trip', 'budget_breach')
        AND pause.schema->'agentPrompt' = NEW.schema->'agentPrompt'
        AND pause.schema->>'supervisorSessionId' = NEW.schema->>'supervisorSessionId'
        AND command.run_id = NEW.run_id AND command.kind = 'session.prompt'
        AND command.owner_kind = 'agent_turn'
        AND command.target_session_id = NEW.schema->>'supervisorSessionId'
        AND command.owner_ref->>'turnId' = NEW.schema->'agentPrompt'->>'turnId'
        AND command.owner_ref->>'promptOrdinal' = NEW.schema->'agentPrompt'->>'promptOrdinal'
        AND command.execution_assignment_id = NEW.schema->'agentPrompt'->>'assignmentId'
        AND command.owner_ref->>'incarnationId' = NEW.schema->'agentPrompt'->>'incarnationId'
    ) THEN
      RAISE EXCEPTION 'agent permission supersession requires its original checkpoint pause'
        USING ERRCODE = '23514', CONSTRAINT = 'hitl_requests_agent_pause_permission_source';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
