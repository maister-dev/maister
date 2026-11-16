CREATE OR REPLACE FUNCTION public.company_retry_source_digest(source runs)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT task_launch_admission_digest(jsonb_build_object(
    'capture',source.company_execution_snapshot,'restrictions',source.knowledge_access,
    'endedAtEpoch',extract(epoch FROM source.ended_at),'terminal',source.operational_terminal
  ))
$function$;
