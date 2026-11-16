CREATE OR REPLACE FUNCTION public.guard_agent_turn_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND run_kind = 'agent') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_agent_run',
      MESSAGE = 'agent turn requires its agent run';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.run_id, NEW.ordinal, NEW.variant, NEW.logical_key, NEW.prompt, NEW.created_at, NEW.parent_turn_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.run_id, OLD.ordinal, OLD.variant, OLD.logical_key, OLD.prompt, OLD.created_at, OLD.parent_turn_id)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_source_immutable',
        MESSAGE = 'accepted agent turn source is immutable';
    END IF;
    IF (OLD.execution_assignment_id IS NOT NULL AND
        ROW(NEW.execution_assignment_id, NEW.assignment_epoch, NEW.run_session_id)
          IS DISTINCT FROM ROW(OLD.execution_assignment_id, OLD.assignment_epoch, OLD.run_session_id))
      OR (OLD.command_id IS NOT NULL AND
        ROW(NEW.incarnation_id, NEW.command_id) IS DISTINCT FROM ROW(OLD.incarnation_id, OLD.command_id))
      OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_binding_immutable',
        MESSAGE = 'bound agent turn identity is immutable';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'queued' AND NEW.state IN ('claimed', 'superseded')) OR
      (OLD.state = 'claimed' AND NEW.state IN ('dispatched', 'superseded')) OR
      (OLD.state = 'dispatched' AND NEW.state IN ('applied', 'superseded'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_transition_check',
        MESSAGE = 'agent turn transition is not allowed';
    END IF;
  END IF;
  IF NEW.parent_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_turns p
    WHERE p.id = NEW.parent_turn_id AND p.run_id = NEW.run_id AND p.variant <> 'steer'
      AND (NEW.variant <> 'steer' OR (
        p.execution_assignment_id IS NOT DISTINCT FROM NEW.execution_assignment_id
        AND p.incarnation_id IS NOT DISTINCT FROM NEW.incarnation_id))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_steer_parent_scope',
      MESSAGE = 'a steer must name a non-steer turn of its own run, on that turn''s assignment and incarnation';
  END IF;
  IF NEW.execution_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments a JOIN run_sessions s ON s.run_id = a.run_id
    WHERE a.id = NEW.execution_assignment_id AND a.run_id = NEW.run_id
      AND a.epoch = NEW.assignment_epoch AND s.id = NEW.run_session_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_binding_scope',
      MESSAGE = 'agent turn binding must belong to its run and assignment epoch';
  END IF;
  IF NEW.command_id IS NOT NULL AND NEW.variant = 'steer' AND NOT EXISTS (
    SELECT 1 FROM execution_commands c JOIN run_session_incarnations i
      ON i.id = NEW.incarnation_id AND i.run_session_id = NEW.run_session_id
    WHERE c.id = NEW.command_id AND c.run_id = NEW.run_id
      AND c.kind = 'session.steer' AND c.owner_kind IS NULL
      AND (NEW.parent_turn_id IS NULL OR c.payload->>'parentCommandId' = (
        SELECT p.command_id FROM agent_turns p WHERE p.id = NEW.parent_turn_id
      ))
      AND c.execution_assignment_id = NEW.execution_assignment_id
      AND c.assignment_epoch = NEW.assignment_epoch
      AND i.execution_assignment_id = NEW.execution_assignment_id
      AND i.assignment_epoch = NEW.assignment_epoch
      AND i.host_session_id = c.target_session_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_command_scope',
      MESSAGE = 'agent steer command must be an owner-less session.steer naming its parent command, on its parent incarnation';
  END IF;
  IF NEW.command_id IS NOT NULL AND NEW.variant <> 'steer' AND NOT EXISTS (
    SELECT 1 FROM execution_commands c JOIN run_session_incarnations i
      ON i.id = NEW.incarnation_id AND i.run_session_id = NEW.run_session_id
    WHERE c.id = NEW.command_id AND c.run_id = NEW.run_id
      AND c.kind = 'session.prompt' AND c.owner_kind = 'agent_turn'
      AND c.execution_assignment_id = NEW.execution_assignment_id
      AND c.assignment_epoch = NEW.assignment_epoch
      AND i.execution_assignment_id = NEW.execution_assignment_id
      AND i.assignment_epoch = NEW.assignment_epoch
      AND i.host_session_id = c.target_session_id
      AND c.owner_ref->>'turnId' = NEW.id
      AND c.owner_ref->>'variant' = NEW.variant
      AND c.owner_ref->'promptOrdinal' = to_jsonb(NEW.ordinal)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'agent_turns_command_scope',
      MESSAGE = 'agent turn command must retain its exact source and incarnation';
  END IF;
  RETURN NEW;
END;
$function$;
