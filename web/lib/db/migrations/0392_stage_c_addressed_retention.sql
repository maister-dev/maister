CREATE OR REPLACE FUNCTION guard_retained_workspace_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE addressed boolean := NEW.kind = 'workspace.preserve'
  OR (NEW.kind = 'workspace.release' AND NEW.payload ? 'claimId');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (addressed OR OLD.kind = 'workspace.preserve' OR (OLD.kind = 'workspace.release' AND OLD.payload ? 'claimId'))
      AND ROW(OLD.kind, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id, OLD.assignment_epoch,
               OLD.target_session_id, OLD.payload, OLD.created_at)
      IS DISTINCT FROM
          ROW(NEW.kind, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id, NEW.assignment_epoch,
               NEW.target_session_id, NEW.payload, NEW.created_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_archive_owner',
        MESSAGE = 'Retained archive request is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT addressed THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces w
    JOIN runs r ON r.id=w.run_id
    JOIN execution_assignments a ON a.id=NEW.execution_assignment_id AND a.run_id=w.run_id
      AND a.execution_host_id=w.execution_host_id AND a.execution_workspace_id=w.execution_workspace_id
      AND a.epoch=NEW.assignment_epoch AND a.state='released'
    WHERE w.run_id=NEW.run_id AND w.execution_host_id=NEW.execution_host_id AND w.execution_workspace_id=NEW.target_session_id
      AND w.ownership_kind='host_owned' AND w.removed_at IS NULL AND to_jsonb(w.workspace_generation)=NEW.payload->'generation'
      AND r.execution_assignment_id=a.id AND r.status=w.lifecycle_operation_expected_run_status
      AND w.lifecycle_operation_state='claiming' AND w.lifecycle_operation_name IN ('archive','retention_gc')
      AND w.lifecycle_operation_attempt_id=NEW.payload->>'claimId'
      AND NEW.payload->>'fence' ~ '^[1-9][0-9]{0,15}$'
      AND NEW.payload->>'quiescenceId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
    FOR UPDATE OF w
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_archive_owner',
      MESSAGE = 'Archive requires the held operation and its released owner';
  END IF;
  IF NEW.kind='workspace.preserve' AND (
    NEW.payload->>'disposition' IS DISTINCT FROM 'archive' OR EXISTS (
      SELECT 1 FROM execution_commands c
      WHERE c.run_id=NEW.run_id AND c.execution_host_id=NEW.execution_host_id AND c.target_session_id=NEW.target_session_id
        AND c.kind IN ('workspace.publish', 'workspace.preserve')
        AND (c.state NOT IN ('succeeded','failed') OR c.payload->>'claimId'=NEW.payload->>'claimId'
          OR (c.payload->>'fence')::numeric >= (NEW.payload->>'fence')::numeric)
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_archive_owner',
      MESSAGE = 'Preservation requires an unused archive claim and a fresh fence';
  END IF;
  IF NEW.kind='workspace.release' AND (
    NOT EXISTS (
      SELECT 1 FROM execution_commands c
      WHERE c.id=NEW.payload->>'dispositionId' AND c.kind='workspace.preserve' AND c.state='succeeded'
        AND c.run_id=NEW.run_id AND c.execution_host_id=NEW.execution_host_id
        AND c.execution_assignment_id=NEW.execution_assignment_id AND c.assignment_epoch=NEW.assignment_epoch
        AND c.target_session_id=NEW.target_session_id
        AND c.payload->'generation'=NEW.payload->'generation' AND c.payload->'fence'=NEW.payload->'fence'
        AND c.payload->'claimId'=NEW.payload->'claimId' AND c.payload->'quiescenceId'=NEW.payload->'quiescenceId'
        AND c.result->>'dispositionId'=c.id
    ) OR EXISTS (
      SELECT 1 FROM execution_commands c
      WHERE c.run_id=NEW.run_id AND c.kind='workspace.release' AND c.state<>'failed'
        AND c.payload->'dispositionId'=NEW.payload->'dispositionId'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_preservation_required',
      MESSAGE = 'Release requires the matching verified archive and no competing release';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_addressed_workspace_disposal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ownership_kind = 'host_owned' AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL AND
    (NEW.removal_kind IS NULL OR NEW.removal_kind IN ('archive','retention_gc','reconciliation'))
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
END $$;
--> statement-breakpoint
CREATE TRIGGER require_addressed_workspace_disposal_receipt BEFORE UPDATE OF removed_at ON workspaces
  FOR EACH ROW EXECUTE FUNCTION require_addressed_workspace_disposal_receipt();
