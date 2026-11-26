CREATE OR REPLACE FUNCTION public.hold_retained_workspace_archive()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (TG_OP='DELETE' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at OR
    NEW.execution_host_id IS DISTINCT FROM OLD.execution_host_id OR
    NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id OR
    NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation OR
    NEW.lifecycle_operation_attempt_id IS DISTINCT FROM OLD.lifecycle_operation_attempt_id OR
    NEW.lifecycle_operation_state IS DISTINCT FROM OLD.lifecycle_operation_state
  ) AND EXISTS (
    SELECT 1 FROM execution_commands c
    WHERE c.run_id=OLD.run_id AND c.kind='workspace.preserve' AND c.state<>'failed'
      AND c.execution_host_id=OLD.execution_host_id AND c.target_session_id=OLD.execution_workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM execution_commands released WHERE released.run_id=c.run_id AND released.kind='workspace.release'
          AND released.state='succeeded' AND released.payload->>'dispositionId'=c.id
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'unsettled_workspace_archive',
      MESSAGE = 'Retained archive owns the checkout until physical release is confirmed';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;
