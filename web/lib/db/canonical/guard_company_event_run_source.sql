CREATE OR REPLACE FUNCTION public.guard_company_event_run_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ((OLD.company_id IS NOT NULL AND OLD.trigger_source='domain_event') OR (NEW.company_id IS NOT NULL AND NEW.trigger_source='domain_event')) AND
      ROW(NEW.company_id,NEW.project_id,NEW.source_agent_id,NEW.agent_schedule_id,NEW.trigger_event_id,NEW.trigger_source,NEW.company_execution_snapshot,NEW.retry_of_run_id)
      IS DISTINCT FROM ROW(OLD.company_id,OLD.project_id,OLD.source_agent_id,OLD.agent_schedule_id,OLD.trigger_event_id,OLD.trigger_source,OLD.company_execution_snapshot,OLD.retry_of_run_id) THEN
      RAISE EXCEPTION 'Company event execution source identity is immutable' USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL OR NEW.trigger_source IS DISTINCT FROM 'domain_event' THEN RETURN NEW; END IF;
  IF NEW.retry_of_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM agent_retry_intents intent
      JOIN LATERAL company_event_retry_source(NEW.retry_of_run_id,NEW.created_by_user_id) source ON true
      WHERE intent.company_id=NEW.company_id AND intent.source_agent_id=NEW.source_agent_id
        AND intent.source_run_id=NEW.retry_of_run_id AND intent.successor_run_id=NEW.id
        AND intent.state='accepted' AND intent.actor_user_id=NEW.created_by_user_id
        AND intent.recipe ? 'replacement'
        AND source.schedule_id=NEW.agent_schedule_id AND source.event_id=NEW.trigger_event_id
        AND source.chain_depth=NEW.agent_chain_depth
        AND intent.recipe->'assignment'=NEW.company_execution_snapshot->'assignment'
    ) THEN
      RAISE EXCEPTION 'Company event replacement requires its exact accepted original invocation'
        USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_scope';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_trigger_attempts invocation
    JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.company_id=invocation.company_id AND event.project_id IS NULL
    JOIN specialist_assignments requested ON requested.id=NEW.company_execution_snapshot->'assignment'->>'id'
      AND requested.company_id=NEW.company_id AND requested.project_id IS NULL
    WHERE invocation.reserved_run_id=NEW.id AND invocation.company_id=NEW.company_id AND invocation.project_id IS NULL
      AND invocation.source_agent_id=NEW.source_agent_id AND invocation.schedule_id=NEW.agent_schedule_id
      AND invocation.trigger_source='domain_event' AND invocation.trigger_event_id=NEW.trigger_event_id AND invocation.outcome IS NULL
      AND requested.origin->>'kind'='event' AND requested.origin->>'eventId'=event.id::text
      AND requested.origin->>'subscriptionId'=invocation.schedule_id
    FOR SHARE OF invocation,event,requested
  ) THEN
    RAISE EXCEPTION 'Company event execution requires its exact owned invocation and assignment origin' USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_scope';
  END IF;
  RETURN NEW;
END;
$function$;
