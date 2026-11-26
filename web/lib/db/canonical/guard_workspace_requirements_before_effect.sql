CREATE OR REPLACE FUNCTION public.guard_workspace_requirements_before_effect()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;
