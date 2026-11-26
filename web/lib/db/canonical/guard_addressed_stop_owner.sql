CREATE OR REPLACE FUNCTION public.guard_addressed_stop_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.addressed_stop_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'An assignment must exist before Stop can claim it'
        USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_workspace_owner_required';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.addressed_stop_requested_at IS NOT NULL THEN
    IF NEW.addressed_stop_requested_at IS DISTINCT FROM OLD.addressed_stop_requested_at
       OR NEW.addressed_stop_requested_by IS DISTINCT FROM OLD.addressed_stop_requested_by THEN
      RAISE EXCEPTION 'Addressed Stop identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.addressed_stop_requested_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs run JOIN workspaces workspace ON workspace.run_id = run.id
    JOIN execution_assignments preparation ON preparation.id=workspace.preparation_assignment_id
    WHERE run.id = NEW.run_id AND run.project_id IS NOT NULL AND run.run_kind = 'flow'
      AND run.status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'WaitingOnChildren',
        'Waiting', 'HumanWorking', 'Review', 'Crashed') AND run.execution_assignment_id = NEW.id
      AND NEW.state = 'active' AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.execution_host_id = NEW.execution_host_id
      AND preparation.run_id = NEW.run_id AND preparation.execution_host_id = NEW.execution_host_id
      AND ((NEW.execution_workspace_id IS NULL AND preparation.id = NEW.id
        AND workspace.execution_workspace_id IS NULL AND run.status='Pending')
        OR (NEW.execution_workspace_id IS NOT NULL
          AND workspace.execution_workspace_id = NEW.execution_workspace_id
          AND preparation.execution_workspace_id = NEW.execution_workspace_id))
  ) THEN
    RAISE EXCEPTION 'Addressed Stop requires the current Flow workspace owner'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_workspace_owner_required';
  END IF;
  RETURN NEW;
END $function$;
