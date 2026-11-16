ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_company_kind_check";--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_kind_check" CHECK (("domain_events"."company_id" IS NULL OR ("domain_events"."task_id" IS NULL AND (("domain_events"."kind" IN ('knowledge.record_changed','specialist.assignment_changed') AND "domain_events"."run_id" IS NULL) OR ("domain_events"."kind" IN ('run.done','run.failed','run.crashed','run.abandoned','run.operational_cleanup_changed') AND "domain_events"."run_id" IS NOT NULL)))) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_company_run_domain_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.company_id IS NOT NULL OR NEW.company_id IS NOT NULL) AND
     ROW(NEW.company_id,NEW.project_id,NEW.run_id,NEW.task_id,NEW.kind) IS DISTINCT FROM
     ROW(OLD.company_id,OLD.project_id,OLD.run_id,OLD.task_id,OLD.kind) THEN
    RAISE EXCEPTION 'Company event ownership and kind are immutable'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_identity_check';
  END IF;
  IF NEW.company_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs execution WHERE execution.id=NEW.run_id
      AND execution.company_id=NEW.company_id AND execution.project_id IS NULL
      AND execution.run_kind='agent' AND execution.agent_kind='operational'
      AND execution.company_execution_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Company run facts require the exact retained execution owner'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_run_reference_check';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER company_run_domain_event_guard BEFORE INSERT OR UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION check_company_run_domain_event();
