CREATE OR REPLACE FUNCTION public.guard_workspace_git_command()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kind IN ('workspace.checkpoint', 'workspace.restore') AND
      (NEW.kind, NEW.run_id, NEW.execution_assignment_id, NEW.execution_host_id, NEW.assignment_epoch,
       NEW.target_session_id, NEW.payload) IS DISTINCT FROM
      (OLD.kind, OLD.run_id, OLD.execution_assignment_id, OLD.execution_host_id, OLD.assignment_epoch,
       OLD.target_session_id, OLD.payload)
    THEN
      RAISE EXCEPTION 'Workspace Git command identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_git_command_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind NOT IN ('workspace.checkpoint', 'workspace.restore') THEN RETURN NEW; END IF;
  PERFORM 1 FROM runs WHERE id = NEW.run_id FOR NO KEY UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM execution_assignments assignment JOIN runs run ON run.id = assignment.run_id
    JOIN workspaces workspace ON workspace.run_id = run.id
    WHERE run.id = NEW.run_id AND run.status IN ('Running', 'NeedsInput') AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id AND assignment.state = 'active' AND assignment.epoch = NEW.assignment_epoch
      AND assignment.execution_host_id = NEW.execution_host_id AND assignment.addressed_stop_requested_at IS NULL
      AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.execution_host_id = assignment.execution_host_id
      AND workspace.execution_workspace_id = assignment.execution_workspace_id AND workspace.execution_workspace_id = NEW.target_session_id
      AND to_jsonb(workspace.workspace_generation) = NEW.payload->'generation'
  ) THEN
    RAISE EXCEPTION 'Workspace Git command requires the current assignment and generation'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_git_command_owner_required';
  END IF;
  IF NEW.kind = 'workspace.restore' AND NOT EXISTS (
    SELECT 1 FROM execution_commands checkpoint WHERE checkpoint.id = NEW.payload->>'checkpointId'
      AND checkpoint.kind = 'workspace.checkpoint' AND checkpoint.state = 'succeeded'
      AND checkpoint.run_id = NEW.run_id AND checkpoint.execution_host_id = NEW.execution_host_id
      AND checkpoint.assignment_epoch <= NEW.assignment_epoch
      AND checkpoint.target_session_id = NEW.target_session_id AND checkpoint.result->'generation' = NEW.payload->'generation'
  ) THEN
    RAISE EXCEPTION 'Workspace restore requires a retained checkpoint for the same owner'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_restore_checkpoint_required';
  END IF;
  RETURN NEW;
END $function$;
