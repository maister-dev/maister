CREATE OR REPLACE FUNCTION public.workspace_flow_setup_pending(owner_assignment text, revision_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
