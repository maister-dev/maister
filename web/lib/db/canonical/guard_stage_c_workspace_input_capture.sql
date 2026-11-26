CREATE OR REPLACE FUNCTION public.guard_stage_c_workspace_input_capture()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Workspace input capture is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_input_capture_immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace JOIN runs run ON run.id = workspace.run_id
    WHERE workspace.id = NEW.workspace_id AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_workspace_id IS NULL AND workspace.removed_at IS NULL
      AND NEW.origin_user_id IS NOT DISTINCT FROM run.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'Workspace input capture requires a logical workspace reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_input_capture_owner_required';
  END IF;
  RETURN NEW;
END $function$;
