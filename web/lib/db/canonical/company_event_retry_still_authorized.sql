CREATE OR REPLACE FUNCTION public.company_event_retry_still_authorized(successor_id text)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs successor JOIN agent_retry_intents intent
      ON intent.successor_run_id=successor.id AND intent.source_run_id=successor.retry_of_run_id
      AND intent.company_id=successor.company_id AND intent.recipe ? 'replacement'
      AND ((intent.state='launched' AND intent.created_run_id=successor.id)
        OR (intent.state='accepted' AND successor.status='Pending'))
    JOIN LATERAL company_event_retry_source(intent.source_run_id,intent.actor_user_id) source ON true
    WHERE successor.id=successor_id AND successor.trigger_source='domain_event'
      AND source.schedule_id=successor.agent_schedule_id AND source.event_id=successor.trigger_event_id
      AND source.chain_depth=successor.agent_chain_depth
  )
$function$;
