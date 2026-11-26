CREATE OR REPLACE FUNCTION public.require_addressed_workspace_disposal_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.ownership_kind = 'host_owned' AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL AND
    (NEW.removal_kind IS NULL OR NEW.removal_kind IN ('archive','drop','discard','retention_gc','reconciliation'))
    AND NOT EXISTS (
      SELECT 1 FROM execution_commands released
      JOIN execution_commands preserved ON preserved.id=released.payload->>'dispositionId'
        AND preserved.kind='workspace.preserve' AND preserved.state='succeeded'
      WHERE released.kind='workspace.release' AND released.state='succeeded'
        AND released.run_id=OLD.run_id AND released.execution_host_id=OLD.execution_host_id
        AND released.target_session_id=OLD.execution_workspace_id
        AND released.payload->>'claimId'=OLD.lifecycle_operation_attempt_id
        AND released.payload->'generation'=to_jsonb(OLD.workspace_generation)
        AND preserved.result->>'retainedCommit'=NEW.archived_commit
        AND NEW.removal_kind=OLD.lifecycle_operation_name
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'addressed_workspace_disposal_receipt',
      MESSAGE = 'An addressed workspace can only be marked removed from its verified disposal receipt';
  END IF;
  RETURN NEW;
END $function$;
