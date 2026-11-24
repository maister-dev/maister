ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.prepare', 'workspace.materialize', 'workspace.run', 'workspace.cancel', 'workspace.release', 'workspace.observe_head', 'workspace.publication', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stage_c_workspace_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind IN ('workspace.prepare', 'workspace.materialize', 'workspace.run', 'workspace.cancel') AND
    ROW(OLD.id, OLD.kind, OLD.created_at, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id,
      OLD.assignment_epoch, OLD.target_session_id, OLD.payload) IS DISTINCT FROM
    ROW(NEW.id, NEW.kind, NEW.created_at, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id,
      NEW.assignment_epoch, NEW.target_session_id, NEW.payload) THEN
    RAISE EXCEPTION 'Workspace preparation command inputs are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_command_immutable';
  END IF;
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.kind = 'workspace.prepare' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    WHERE workspace.id = NEW.target_session_id
      AND workspace.run_id = NEW.run_id
      AND run.status = 'Pending'
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.state = 'active'
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_workspace_id IS NULL
      AND workspace.workspace_input_digest = NEW.payload->>'inputDigest'
      AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Workspace preparation requires its pending Run and exact assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_owner_required';
  END IF;
  IF NEW.kind = 'workspace.materialize' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    JOIN runs run ON run.id = workspace.run_id
    WHERE workspace.run_id = NEW.run_id AND run.status = 'Pending'
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id AND assignment.state = 'active'
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.execution_workspace_id = NEW.target_session_id
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.workspace_materialization_generation IS NULL
      AND to_jsonb(workspace.workspace_generation) = NEW.payload->'generation'
      AND NEW.payload->>'manifestDigest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(NEW.payload->'objects') = 'array'
  ) THEN
    RAISE EXCEPTION 'Input materialization requires its prepared workspace and exact assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_materialization_owner_required';
  END IF;
  IF NEW.kind IN ('workspace.run', 'workspace.cancel') AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    JOIN runs run ON run.id = workspace.run_id
    WHERE workspace.run_id = NEW.run_id
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id AND assignment.state = 'active'
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.execution_workspace_id = NEW.target_session_id
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND to_jsonb(workspace.workspace_generation) = NEW.payload->'generation'
      AND workspace.workspace_materialization_generation IS NOT NULL
      AND (
        (NEW.kind = 'workspace.run' AND (run.status = 'Running' OR
          (run.status = 'Pending' AND NEW.payload->>'workload' = 'requirementProbe'))
          AND to_jsonb(workspace.workspace_materialization_generation) = NEW.payload->'inputGeneration'
          AND NEW.payload->>'workload' IN ('setup', 'cli', 'check', 'requirementProbe')
          AND NEW.payload->>'declarationId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
          AND EXISTS (SELECT 1 FROM execution_commands applied
            WHERE applied.run_id = NEW.run_id AND applied.execution_assignment_id = assignment.id
              AND applied.kind = 'workspace.materialize' AND applied.state = 'succeeded'
              AND applied.result->>'manifestDigest' = NEW.payload->>'inputDigest'))
        OR
        (NEW.kind = 'workspace.cancel' AND EXISTS (SELECT 1 FROM execution_commands target
          WHERE target.id = NEW.payload->>'targetCommandId' AND target.kind = 'workspace.run'
            AND target.run_id = NEW.run_id AND target.execution_assignment_id = assignment.id
            AND target.target_session_id = NEW.target_session_id
            AND target.payload->'generation' = NEW.payload->'generation'))
      )
  ) THEN
    RAISE EXCEPTION 'Workspace workload requires its current assignment, generation and input receipt'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_workload_owner_required';
  END IF;
  IF NEW.kind IN ('session.create', 'session.prompt') AND EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned'
      AND workspace.workspace_materialization_generation IS NULL AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Session dispatch requires the prepared workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_preparation_pending';
  END IF;
  RETURN NEW;
END $$;
