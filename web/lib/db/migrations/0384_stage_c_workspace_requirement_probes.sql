ALTER TABLE "workspace_input_captures" ADD COLUMN "requirement_probe_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_input_captures" ADD CONSTRAINT "workspace_input_captures_probe_count_check" CHECK ("workspace_input_captures"."requirement_probe_count" BETWEEN 0 AND 128);--> statement-breakpoint
CREATE FUNCTION next_workspace_requirement_probe(owner_assignment text, probe_count integer)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT min(probe.idx)
  FROM generate_series(0, probe_count - 1) AS probe(idx)
  WHERE NOT EXISTS (
    SELECT 1 FROM execution_commands command
    WHERE command.execution_assignment_id = owner_assignment
      AND command.kind = 'workspace.run' AND command.state = 'succeeded'
      AND command.payload->>'workload' = 'requirementProbe'
      AND command.payload->>'declarationId' = 'probe:' || probe.idx
      AND command.result->>'quiescence' = 'proved'
      AND command.result->>'processOutcome' = 'exited'
      AND command.result->>'exitCode' = '0'
  );
$$;--> statement-breakpoint
CREATE FUNCTION guard_workspace_requirements_before_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required_index integer;
BEGIN
  IF NEW.kind NOT IN ('workspace.run', 'session.create', 'session.prompt') THEN
    RETURN NEW;
  END IF;
  IF NEW.kind = 'workspace.run' AND NEW.payload->>'workload' = 'requirementProbe' THEN
    PERFORM 1 FROM runs WHERE id = NEW.run_id FOR UPDATE;
  END IF;
  SELECT next_workspace_requirement_probe(workspace.preparation_assignment_id, capture.requirement_probe_count)
  INTO required_index
  FROM workspaces workspace JOIN workspace_input_captures capture ON capture.workspace_id = workspace.id
  WHERE workspace.run_id = NEW.run_id AND workspace.ownership_kind = 'host_owned' AND workspace.removed_at IS NULL;
  IF NEW.kind = 'workspace.run' AND NEW.payload->>'workload' = 'requirementProbe' THEN
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
END $$;--> statement-breakpoint
CREATE TRIGGER guard_workspace_requirements_before_effect
  BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION guard_workspace_requirements_before_effect();
