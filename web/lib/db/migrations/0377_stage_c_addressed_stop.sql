ALTER TABLE "execution_assignments" ADD COLUMN "addressed_stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD COLUMN "addressed_stop_requested_by" text;--> statement-breakpoint
ALTER TABLE "execution_assignments" ADD CONSTRAINT "execution_assignments_addressed_stop_check" CHECK ((("execution_assignments"."addressed_stop_requested_at" IS NULL AND "execution_assignments"."addressed_stop_requested_by" IS NULL) OR ("execution_assignments"."addressed_stop_requested_at" IS NOT NULL AND char_length("execution_assignments"."addressed_stop_requested_by") BETWEEN 1 AND 128 AND "execution_assignments"."execution_workspace_id" IS NOT NULL)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_addressed_stop_before_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stop_requested boolean;
BEGIN
  IF NEW.kind NOT IN ('workspace.run', 'session.create', 'session.prompt', 'session.input', 'session.steer') THEN
    RETURN NEW;
  END IF;
  SELECT addressed_stop_requested_at IS NOT NULL INTO stop_requested
  FROM execution_assignments WHERE id = NEW.execution_assignment_id FOR SHARE;
  IF stop_requested IS TRUE THEN
    RAISE EXCEPTION 'Addressed Stop holds the execution assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_pending';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER guard_addressed_stop_before_execution
  BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION guard_addressed_stop_before_execution();
--> statement-breakpoint
CREATE FUNCTION guard_addressed_stop_owner() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE run.id = NEW.run_id AND run.project_id IS NOT NULL AND run.run_kind = 'flow'
      AND run.status IN ('Running', 'NeedsInput') AND run.execution_assignment_id = NEW.id
      AND NEW.state = 'active' AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.preparation_assignment_id = NEW.id AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.execution_workspace_id = NEW.execution_workspace_id
  ) THEN
    RAISE EXCEPTION 'Addressed Stop requires the current Flow workspace owner'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_workspace_owner_required';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER guard_addressed_stop_owner
  BEFORE INSERT OR UPDATE OF addressed_stop_requested_at, addressed_stop_requested_by ON execution_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_addressed_stop_owner();
