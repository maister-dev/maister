CREATE OR REPLACE FUNCTION public.guard_retained_workspace_publication()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kind = 'workspace.publish' AND
      ROW(OLD.kind, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id,
          OLD.assignment_epoch, OLD.target_session_id, OLD.payload, OLD.created_at)
      IS DISTINCT FROM
      ROW(NEW.kind, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id,
          NEW.assignment_epoch, NEW.target_session_id, NEW.payload, NEW.created_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_publication_owner',
        MESSAGE = 'Retained publication request is immutable';
    END IF;
    IF NEW.kind <> 'workspace.publish' OR OLD.kind = 'workspace.publish' THEN RETURN NEW; END IF;
  END IF;
  IF NEW.kind <> 'workspace.publish' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces w JOIN execution_assignments a
      ON a.id = NEW.execution_assignment_id AND a.run_id = w.run_id
        AND a.execution_host_id = w.execution_host_id
        AND a.execution_workspace_id = w.execution_workspace_id AND a.epoch = NEW.assignment_epoch
    WHERE w.run_id = NEW.run_id AND w.execution_host_id = NEW.execution_host_id
      AND w.execution_workspace_id = NEW.target_session_id AND w.ownership_kind = 'host_owned'
      AND w.removed_at IS NULL AND w.workspace_generation::text = NEW.payload->>'generation'
      AND (
        (w.promotion_state = 'claiming' AND w.promotion_attempt_id = NEW.payload->>'claimId') OR
        (w.lifecycle_operation_state = 'claiming' AND w.lifecycle_operation_attempt_id = NEW.payload->>'claimId')
      )
      AND NEW.payload->>'fence' ~ '^[1-9][0-9]{0,15}$'
    FOR UPDATE OF w
  ) OR EXISTS (
    SELECT 1 FROM execution_commands c
    WHERE c.kind = 'workspace.publish' AND c.execution_host_id = NEW.execution_host_id
      AND c.target_session_id = NEW.target_session_id AND (
        c.payload->>'claimId' = NEW.payload->>'claimId' OR
        (c.payload->>'fence')::numeric >= (NEW.payload->>'fence')::numeric OR
        c.state NOT IN ('succeeded', 'failed')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_publication_owner',
      MESSAGE = 'Publication requires an exclusive retained workspace claim and a fresh fence';
  END IF;
  RETURN NEW;
END $function$;
