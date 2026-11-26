ALTER TABLE "execution_events" DROP CONSTRAINT "execution_events_protocol_bounds_check";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workspace_materialization_generation" integer;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_protocol_bounds_check" CHECK (("execution_events"."host_sequence" IS NULL OR "execution_events"."host_sequence" >= 0) AND ("execution_events"."run_sequence" IS NULL OR "execution_events"."run_sequence" >= 0) AND ("execution_events"."assignment_epoch" IS NULL OR "execution_events"."assignment_epoch" >= 1) AND ("execution_events"."payload_bytes" IS NULL OR "execution_events"."payload_bytes" BETWEEN 0 AND 1048576) AND ("execution_events"."source" <> 'host' OR ("execution_events"."execution_host_id" IS NOT NULL AND "execution_events"."host_boot_id" IS NOT NULL AND ("execution_events"."envelope_version" = 1 OR ("execution_events"."envelope_version" = 2 AND "execution_events"."event_type" = 'workspace.command.terminal' AND "execution_events"."payload_schema" = 'maister.workspace.command.terminal.v1')))));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_host_materialization_shape_check" CHECK ("workspaces"."workspace_materialization_generation" IS NULL OR (
        "workspaces"."ownership_kind" = 'host_owned' AND "workspaces"."workspace_materialization_generation" > 0
        AND ("workspaces"."execution_workspace_id" IS NOT NULL OR "workspaces"."root_workspace_id" IS NOT NULL)
      ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stage_c_workspace_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind = 'workspace.prepare' AND
    ROW(OLD.id, OLD.kind, OLD.created_at, OLD.run_id, OLD.execution_host_id, OLD.execution_assignment_id,
      OLD.assignment_epoch, OLD.target_session_id, OLD.payload) IS DISTINCT FROM
    ROW(NEW.id, NEW.kind, NEW.created_at, NEW.run_id, NEW.execution_host_id, NEW.execution_assignment_id,
      NEW.assignment_epoch, NEW.target_session_id, NEW.payload) THEN
    RAISE EXCEPTION 'Workspace preparation command inputs are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_command_immutable';
  END IF;
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.kind = 'workspace.prepare' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    WHERE workspace.id = NEW.target_session_id
      AND workspace.run_id = NEW.run_id
      AND run.status = 'Pending'
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.state = 'active'
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned'
      AND workspace.execution_workspace_id IS NULL
      AND workspace.workspace_input_digest = NEW.payload->>'inputDigest'
      AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Workspace preparation requires its pending Run and exact assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_prepare_owner_required';
  END IF;
  IF NEW.kind IN ('session.create', 'session.prompt') AND EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned'
      AND workspace.workspace_materialization_generation IS NULL AND workspace.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Session dispatch requires the prepared workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_preparation_pending';
  END IF;
  RETURN NEW;
END $$;
