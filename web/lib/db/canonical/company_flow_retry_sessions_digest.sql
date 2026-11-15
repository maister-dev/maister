CREATE OR REPLACE FUNCTION public.company_flow_retry_sessions_digest(source_id text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT task_launch_admission_digest(jsonb_agg(jsonb_build_object(
    'sessionName',session_name,'runnerId',runner_id,'runner',runner_snapshot,
    'tier',runner_resolution_tier,'source',resolution_source,'warning',resolution_warning
  ) ORDER BY session_name)) FROM run_sessions WHERE run_id=source_id
$function$;
