CREATE OR REPLACE FUNCTION public.next_workspace_requirement_probe(owner_assignment text, probe_count integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
