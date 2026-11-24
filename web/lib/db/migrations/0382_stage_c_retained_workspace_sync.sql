ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.prepare', 'workspace.materialize', 'workspace.run', 'workspace.cancel', 'workspace.checkpoint', 'workspace.restore', 'workspace.sync', 'workspace.publish', 'workspace.preserve', 'workspace.release', 'workspace.observe_head', 'workspace.publication', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));
--> statement-breakpoint
CREATE FUNCTION guard_retained_workspace_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.kind = 'workspace.sync' OR OLD.kind = 'workspace.sync')
      AND ROW(OLD.kind, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id,
              OLD.assignment_epoch, OLD.target_session_id, OLD.payload, OLD.created_at)
      IS DISTINCT FROM
          ROW(NEW.kind, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id,
              NEW.assignment_epoch, NEW.target_session_id, NEW.payload, NEW.created_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_sync_owner',
        MESSAGE = 'Retained sync request is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind NOT IN ('workspace.sync', 'workspace.publish', 'workspace.preserve') THEN RETURN NEW; END IF;
  IF NEW.kind = 'workspace.sync' AND NOT EXISTS (
    SELECT 1 FROM workspaces w
    JOIN runs r ON r.id=w.run_id
    JOIN run_sync_attempts s ON s.workspace_id=w.id AND s.run_id=w.run_id AND s.id=w.lifecycle_operation_attempt_id
    JOIN execution_assignments a ON a.id=NEW.execution_assignment_id AND a.run_id=w.run_id
      AND a.execution_host_id=w.execution_host_id AND a.execution_workspace_id=w.execution_workspace_id
      AND a.epoch=NEW.assignment_epoch AND a.state='released'
    WHERE w.run_id=NEW.run_id AND w.execution_host_id=NEW.execution_host_id AND w.execution_workspace_id=NEW.target_session_id
      AND w.ownership_kind='host_owned' AND w.removed_at IS NULL AND to_jsonb(w.workspace_generation)=NEW.payload->'generation'
      AND r.execution_assignment_id=a.id AND r.status=w.lifecycle_operation_expected_run_status
      AND w.lifecycle_operation_state='claiming' AND w.lifecycle_operation_name='sync'
      AND w.lifecycle_operation_attempt_id=NEW.payload->>'claimId'
      AND NEW.payload->>'fence' ~ '^[1-9][0-9]{0,15}$'
      AND s.phase='starting' AND s.mode='mechanical' AND s.strategy=NEW.payload->>'strategy'
      AND s.head_sha_before=NEW.payload->'expected'->>'head'
      AND s.target_sha=NEW.payload->'expected'->>'priorTarget'
      AND NEW.payload->'expected'->>'remoteId'=r.project_id
    FOR UPDATE OF w
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_sync_owner',
      MESSAGE = 'Sync requires the held operation, matching attempt and released owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM execution_commands c
    WHERE c.kind IN ('workspace.sync', 'workspace.publish', 'workspace.preserve')
      AND (NEW.kind='workspace.sync' OR c.kind='workspace.sync')
      AND c.execution_host_id=NEW.execution_host_id AND c.target_session_id=NEW.target_session_id
      AND (c.state NOT IN ('succeeded','failed') OR c.payload->>'claimId'=NEW.payload->>'claimId'
        OR (c.payload->>'fence')::numeric >= (NEW.payload->>'fence')::numeric)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'retained_workspace_sync_owner',
      MESSAGE = 'Sync and other operations require one fresh workspace fence';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_retained_workspace_sync BEFORE INSERT OR UPDATE ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_retained_workspace_sync();
--> statement-breakpoint
CREATE FUNCTION hold_unsettled_workspace_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at OR
    NEW.execution_host_id IS DISTINCT FROM OLD.execution_host_id OR
    NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id OR
    NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation OR
    NEW.lifecycle_operation_attempt_id IS DISTINCT FROM OLD.lifecycle_operation_attempt_id OR
    NEW.lifecycle_operation_state IS DISTINCT FROM OLD.lifecycle_operation_state
  ) AND EXISTS (
    SELECT 1 FROM execution_commands c
    WHERE c.run_id=OLD.run_id AND c.kind='workspace.sync' AND c.state NOT IN ('succeeded','failed')
      AND c.execution_host_id=OLD.execution_host_id AND c.target_session_id=OLD.execution_workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'unsettled_workspace_sync',
      MESSAGE = 'Unsettled sync still holds the retained workspace';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hold_unsettled_workspace_sync BEFORE UPDATE OR DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION hold_unsettled_workspace_sync();
