ALTER TABLE "workspace_input_captures" ADD COLUMN "flow_setup_revision_id" text;--> statement-breakpoint
ALTER TABLE "workspace_input_captures" ADD CONSTRAINT "workspace_input_captures_setup_revision_check" CHECK ("workspace_input_captures"."flow_setup_revision_id" ~ '^[A-Za-z0-9_-]{1,128}$');
--> statement-breakpoint
CREATE FUNCTION workspace_flow_setup_pending(owner_assignment text, revision_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM execution_commands setup
    WHERE setup.execution_assignment_id = owner_assignment
      AND setup.kind = 'workspace.run' AND setup.state = 'succeeded'
      AND setup.payload->>'workload' = 'setup'
      AND setup.payload->>'declarationId' = 'flow:setup'
      AND setup.result->>'processOutcome' = 'exited'
      AND setup.result->>'exitCode' = '0'
      AND setup.result->>'quiescence' = 'proved'
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_stage_c_workspace_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind IN ('workspace.prepare', 'workspace.materialize', 'workspace.run', 'workspace.cancel') AND
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
  IF NEW.kind = 'workspace.materialize' AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN execution_assignments assignment ON assignment.id = workspace.preparation_assignment_id
    JOIN runs run ON run.id = workspace.run_id
    WHERE workspace.run_id = NEW.run_id AND run.status = 'Pending'
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id AND assignment.state = 'active'
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.execution_workspace_id = NEW.target_session_id
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND workspace.workspace_materialization_generation IS NULL
      AND to_jsonb(workspace.workspace_generation) = NEW.payload->'generation'
      AND NEW.payload->>'manifestDigest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(NEW.payload->'objects') = 'array'
  ) THEN
    RAISE EXCEPTION 'Input materialization requires its prepared workspace and exact assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_materialization_owner_required';
  END IF;
  IF NEW.kind IN ('workspace.run', 'workspace.cancel') AND NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    JOIN runs run ON run.id = workspace.run_id
    JOIN execution_assignments assignment ON assignment.id = run.execution_assignment_id
    JOIN execution_assignments preparation ON preparation.id = workspace.preparation_assignment_id
      AND preparation.run_id = workspace.run_id AND preparation.execution_host_id = assignment.execution_host_id
      AND preparation.execution_workspace_id = assignment.execution_workspace_id
    WHERE workspace.run_id = NEW.run_id
      AND run.execution_assignment_id = assignment.id
      AND assignment.id = NEW.execution_assignment_id AND assignment.state = 'active'
      AND assignment.epoch = NEW.assignment_epoch
      AND assignment.execution_workspace_id = NEW.target_session_id
      AND assignment.execution_host_id = NEW.execution_host_id
      AND workspace.execution_host_id = NEW.execution_host_id
      AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL
      AND to_jsonb(workspace.workspace_generation) = NEW.payload->'generation'
      AND workspace.workspace_materialization_generation IS NOT NULL
      AND (
        (NEW.kind = 'workspace.run' AND (run.status = 'Running' OR
          (run.status = 'Pending' AND NEW.payload->>'workload' IN ('setup', 'requirementProbe')))
          AND to_jsonb(workspace.workspace_materialization_generation) = NEW.payload->'inputGeneration'
          AND NEW.payload->>'workload' IN ('setup', 'cli', 'check', 'requirementProbe')
          AND NEW.payload->>'declarationId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
          AND EXISTS (SELECT 1 FROM execution_commands applied
            WHERE applied.run_id = NEW.run_id AND applied.execution_assignment_id = preparation.id
              AND applied.kind = 'workspace.materialize' AND applied.state = 'succeeded'
              AND applied.result->'generation' = NEW.payload->'generation'
              AND applied.result->'inputGeneration' = NEW.payload->'inputGeneration'
              AND applied.result->>'manifestDigest' = NEW.payload->>'inputDigest'))
        OR
        (NEW.kind = 'workspace.cancel' AND EXISTS (SELECT 1 FROM execution_commands target
          WHERE target.id = NEW.payload->>'targetCommandId' AND target.kind = 'workspace.run'
            AND target.run_id = NEW.run_id AND target.execution_assignment_id = assignment.id
            AND target.target_session_id = NEW.target_session_id
            AND target.payload->'generation' = NEW.payload->'generation'))
      )
  ) THEN
    RAISE EXCEPTION 'Workspace workload requires its current assignment, generation and input receipt'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_workload_owner_required';
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_workspace_requirements_before_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required_index integer;
  setup_revision text;
  setup_pending boolean;
BEGIN
  IF NEW.kind NOT IN ('workspace.run', 'session.create', 'session.prompt') THEN
    RETURN NEW;
  END IF;
  IF NEW.kind = 'workspace.run' AND NEW.payload->>'workload' IN ('setup', 'requirementProbe') THEN
    PERFORM 1 FROM runs WHERE id = NEW.run_id FOR UPDATE;
  END IF;
  SELECT next_workspace_requirement_probe(workspace.preparation_assignment_id, capture.requirement_probe_count),
    capture.flow_setup_revision_id,
    workspace_flow_setup_pending(workspace.preparation_assignment_id, capture.flow_setup_revision_id)
  INTO required_index, setup_revision, setup_pending
  FROM workspaces workspace JOIN workspace_input_captures capture ON capture.workspace_id = workspace.id
  WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL;
  IF NEW.kind = 'workspace.run' AND NEW.payload->>'workload' = 'setup' THEN
    IF NOT COALESCE(setup_pending, false) OR NEW.payload->>'declarationId' IS DISTINCT FROM 'flow:setup' OR
      NOT EXISTS (
        SELECT 1 FROM runs run
        JOIN flow_revisions revision ON revision.id = run.flow_revision_id
        WHERE run.id = NEW.run_id AND run.status = 'Pending'
          AND revision.id = setup_revision AND revision.exec_trust = 'trusted'
          AND revision.package_status = 'Installed'
      ) OR EXISTS (
        SELECT 1 FROM execution_commands command
        WHERE command.execution_assignment_id = NEW.execution_assignment_id
          AND command.kind = 'workspace.run' AND command.payload->>'workload' = 'setup'
      ) THEN
      RAISE EXCEPTION 'Setup admission requires the frozen trusted revision'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_flow_setup_invalid';
    END IF;
  ELSIF setup_pending THEN
    RAISE EXCEPTION 'Execution requires successful selected-supervisor setup'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_flow_setup_pending';
  ELSIF NEW.kind = 'workspace.run' AND NEW.payload->>'workload' = 'requirementProbe' THEN
    IF required_index IS NULL OR NEW.payload->>'declarationId' <> 'probe:' || required_index OR
      NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status = 'Pending') OR
      EXISTS (SELECT 1 FROM execution_commands command
        WHERE command.execution_assignment_id = NEW.execution_assignment_id AND command.kind = 'workspace.run'
          AND command.payload->>'workload' = 'requirementProbe'
          AND command.payload->>'declarationId' = NEW.payload->>'declarationId') THEN
      RAISE EXCEPTION 'Probe admission requires the next frozen workspace requirement'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_requirement_probe_invalid';
    END IF;
  ELSIF required_index IS NOT NULL THEN
    RAISE EXCEPTION 'Execution requires successful workspace requirement probes'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_requirements_pending';
  END IF;
  RETURN NEW;
END $$;
