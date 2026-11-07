DROP INDEX "runs_agent_trigger_event_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_company_trigger_event_uq" ON "runs" USING btree ("company_id","source_agent_id","agent_schedule_id","trigger_event_id") WHERE "runs"."company_id" IS NOT NULL AND "runs"."trigger_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_agent_trigger_event_uq" ON "runs" USING btree ("agent_id","trigger_event_id") WHERE "runs"."trigger_event_id" IS NOT NULL AND "runs"."company_id" IS NULL;--> statement-breakpoint
CREATE FUNCTION guard_company_event_run_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ((OLD.company_id IS NOT NULL AND OLD.trigger_source='domain_event') OR (NEW.company_id IS NOT NULL AND NEW.trigger_source='domain_event')) AND
      ROW(NEW.company_id,NEW.project_id,NEW.source_agent_id,NEW.agent_schedule_id,NEW.trigger_event_id,NEW.trigger_source,NEW.company_execution_snapshot)
      IS DISTINCT FROM ROW(OLD.company_id,OLD.project_id,OLD.source_agent_id,OLD.agent_schedule_id,OLD.trigger_event_id,OLD.trigger_source,OLD.company_execution_snapshot) THEN
      RAISE EXCEPTION 'Company event execution source identity is immutable' USING ERRCODE='23514',CONSTRAINT='runs_company_event_source_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL OR NEW.trigger_source IS DISTINCT FROM 'domain_event' THEN RETURN NEW; END IF;
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
$$;--> statement-breakpoint
CREATE TRIGGER runs_company_event_source_guard BEFORE INSERT OR UPDATE OF company_id,project_id,source_agent_id,agent_schedule_id,trigger_event_id,trigger_source,company_execution_snapshot ON runs FOR EACH ROW EXECUTE FUNCTION guard_company_event_run_source();
