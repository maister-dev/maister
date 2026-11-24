ALTER TABLE "execution_commands" DROP CONSTRAINT "execution_commands_kind_check";--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_kind_check" CHECK ("execution_commands"."kind" in ('workspace.adopt', 'workspace.prepare', 'workspace.materialize', 'workspace.run', 'workspace.cancel', 'workspace.checkpoint', 'workspace.restore', 'workspace.publish', 'workspace.release', 'workspace.observe_head', 'workspace.publication', 'session.create', 'session.prompt', 'session.input', 'session.steer', 'session.cancel', 'session.checkpoint', 'session.delete', 'runtime_object.reserve', 'runtime_object.upload', 'runtime_object.delete', 'stand.dispatch'));
--> statement-breakpoint
CREATE FUNCTION guard_retained_workspace_publication() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_retained_workspace_publication BEFORE INSERT OR UPDATE ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_retained_workspace_publication();
--> statement-breakpoint
CREATE FUNCTION hold_unsettled_workspace_publication() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE TRIGGER hold_unsettled_workspace_publication BEFORE UPDATE OR DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION hold_unsettled_workspace_publication();
