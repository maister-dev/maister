ALTER TABLE "execution_assignments" DROP CONSTRAINT "execution_assignments_addressed_stop_check";--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_addressed_stop_check" CHECK ((("execution_assignments"."addressed_stop_requested_at" IS NULL AND "execution_assignments"."addressed_stop_requested_by" IS NULL) OR ("execution_assignments"."addressed_stop_requested_at" IS NOT NULL AND char_length("execution_assignments"."addressed_stop_requested_by") BETWEEN 1 AND 128)) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_addressed_stop_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.addressed_stop_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'An assignment must exist before Stop can claim it'
        USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_workspace_owner_required';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.addressed_stop_requested_at IS NOT NULL THEN
    IF NEW.addressed_stop_requested_at IS DISTINCT FROM OLD.addressed_stop_requested_at
       OR NEW.addressed_stop_requested_by IS DISTINCT FROM OLD.addressed_stop_requested_by THEN
      RAISE EXCEPTION 'Addressed Stop identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.addressed_stop_requested_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs run JOIN workspaces workspace ON workspace.run_id = run.id
    JOIN execution_assignments preparation ON preparation.id=workspace.preparation_assignment_id
    WHERE run.id = NEW.run_id AND run.project_id IS NOT NULL AND run.run_kind = 'flow'
      AND run.status IN ('Pending', 'Running', 'NeedsInput', 'NeedsInputIdle', 'WaitingOnChildren',
        'Waiting', 'HumanWorking', 'Review', 'Crashed') AND run.execution_assignment_id = NEW.id
      AND NEW.state = 'active' AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.execution_host_id = NEW.execution_host_id
      AND preparation.run_id = NEW.run_id AND preparation.execution_host_id = NEW.execution_host_id
      AND ((NEW.execution_workspace_id IS NULL AND preparation.id = NEW.id
        AND workspace.execution_workspace_id IS NULL AND run.status='Pending')
        OR (NEW.execution_workspace_id IS NOT NULL
          AND workspace.execution_workspace_id = NEW.execution_workspace_id
          AND preparation.execution_workspace_id = NEW.execution_workspace_id))
  ) THEN
    RAISE EXCEPTION 'Addressed Stop requires the current Flow workspace owner'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_workspace_owner_required';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_addressed_stop_before_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stop_requested boolean;
DECLARE ancestor_stopped boolean;
BEGIN
  IF NEW.kind NOT IN ('workspace.prepare', 'workspace.materialize', 'workspace.run',
    'session.create', 'session.prompt', 'session.input', 'session.steer') THEN
    RETURN NEW;
  END IF;
  SELECT addressed_stop_requested_at IS NOT NULL INTO stop_requested
  FROM execution_assignments WHERE id = NEW.execution_assignment_id FOR SHARE;
  WITH RECURSIVE ancestors AS (
      SELECT parent.id,parent.parent_run_id,parent.execution_assignment_id FROM runs child
      JOIN runs parent ON parent.id=child.parent_run_id WHERE child.id=NEW.run_id
      UNION
      SELECT parent.id,parent.parent_run_id,parent.execution_assignment_id
      FROM runs parent JOIN ancestors child ON parent.id=child.parent_run_id
    )
  SELECT bool_or(requested) INTO ancestor_stopped FROM (
    SELECT owner.addressed_stop_requested_at IS NOT NULL AS requested
    FROM ancestors JOIN execution_assignments owner ON owner.id=ancestors.execution_assignment_id
    ORDER BY owner.id FOR SHARE OF owner
  ) locked;
  IF stop_requested OR ancestor_stopped THEN
    RAISE EXCEPTION 'Addressed Stop holds the execution assignment or an ancestor'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_pending';
  END IF;
  RETURN NEW;
END $$;
