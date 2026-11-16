CREATE OR REPLACE FUNCTION public.company_retry_has_dispatch_witness(source_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS(SELECT 1 FROM domain_events event WHERE event.run_id=source_id
    AND event.kind IN ('run.failed','run.crashed') AND event.payload->'cause'->>'source'='agent'
    AND event.payload->>'failurePhase'='before_dispatch')
$function$;
