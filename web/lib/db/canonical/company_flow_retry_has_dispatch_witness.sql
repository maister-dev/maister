CREATE OR REPLACE FUNCTION public.company_flow_retry_has_dispatch_witness(source_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS(SELECT 1 FROM domain_events event WHERE event.run_id=source_id
    AND event.kind='run.failed' AND event.payload->'cause'->>'source'='graph'
    AND event.payload->>'failurePhase'='before_dispatch')
    AND NOT EXISTS (SELECT 1 FROM node_attempts WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM runs WHERE parent_run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM specialist_work WHERE parent_run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM execution_commands WHERE run_id=source_id AND kind<>'workspace.release')
    AND NOT EXISTS (SELECT 1 FROM run_session_incarnations WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM run_results WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM hitl_requests WHERE run_id=source_id)
$function$;
