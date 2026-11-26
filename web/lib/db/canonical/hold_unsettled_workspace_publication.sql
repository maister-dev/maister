CREATE OR REPLACE FUNCTION public.hold_unsettled_workspace_publication()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM execution_commands c
    WHERE c.run_id = OLD.run_id AND c.kind = 'workspace.publish'
      AND c.execution_host_id = OLD.execution_host_id AND c.target_session_id = OLD.execution_workspace_id
      AND c.state NOT IN ('succeeded', 'failed')
      AND (
        TG_OP = 'DELETE' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at OR
        NEW.execution_host_id IS DISTINCT FROM OLD.execution_host_id OR
        NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id OR
        NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation OR
        (OLD.promotion_attempt_id = c.payload->>'claimId' AND (
          NEW.promotion_attempt_id IS DISTINCT FROM OLD.promotion_attempt_id OR
          NEW.promotion_state IS DISTINCT FROM OLD.promotion_state
        )) OR
        (OLD.lifecycle_operation_attempt_id = c.payload->>'claimId' AND (
          NEW.lifecycle_operation_attempt_id IS DISTINCT FROM OLD.lifecycle_operation_attempt_id OR
          NEW.lifecycle_operation_state IS DISTINCT FROM OLD.lifecycle_operation_state
        ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'unsettled_workspace_publication',
      MESSAGE = 'Unsettled publication still holds the retained workspace';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;
