CREATE OR REPLACE FUNCTION public.guard_addressed_task_launch_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    WHERE run.id = NEW.run_id
      AND run.task_launch_intent_id = NEW.id
      AND workspace.project_id = NEW.project_id
      AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_host_id = NEW.effective_execution_host_id
      AND workspace.branch = NEW.preparation_identity->>'branch'
      AND workspace.base_commit = NEW.preparation_identity->>'baseCommit'
      AND assignment.id = run.execution_assignment_id
      AND assignment.execution_host_id = NEW.effective_execution_host_id
      AND assignment.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Addressed launch binding requires the accepted host, checkout and assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_task_launch_binding';
  END IF;
  RETURN NEW;
END $function$;
