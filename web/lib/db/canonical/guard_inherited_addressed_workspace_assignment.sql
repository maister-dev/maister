CREATE OR REPLACE FUNCTION public.guard_inherited_addressed_workspace_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN execution_assignments preparation ON preparation.id = workspace.preparation_assignment_id
    WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned'
      AND workspace.removed_at IS NULL AND preparation.execution_workspace_id IS NOT NULL
      AND (NEW.execution_host_id, NEW.execution_workspace_id) IS DISTINCT FROM
          (preparation.execution_host_id, preparation.execution_workspace_id)
  ) THEN
    RAISE EXCEPTION 'An inherited addressed workspace requires its original host and handle'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_assignment_inherited_owner_required';
  END IF;
  RETURN NEW;
END $function$;
