ALTER TABLE "agent_schedules" ADD COLUMN "request_at_launch" text;--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD COLUMN "scheduled_request_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "scheduled_request_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_request_shape" CHECK ("agent_schedules"."request_at_launch" IS NULL OR ("agent_schedules"."trigger_type" = 'cron' AND char_length("agent_schedules"."request_at_launch") BETWEEN 1 AND 8000));--> statement-breakpoint
ALTER TABLE "agent_trigger_attempts" ADD CONSTRAINT "agent_trigger_attempts_scheduled_request_shape" CHECK (("agent_trigger_attempts"."scheduled_request_snapshot" IS NULL OR CASE WHEN jsonb_typeof("agent_trigger_attempts"."scheduled_request_snapshot") = 'object' THEN (
    "agent_trigger_attempts"."scheduled_request_snapshot" ?& ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch']
    AND "agent_trigger_attempts"."scheduled_request_snapshot" - ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch'] = '{}'::jsonb
    AND "agent_trigger_attempts"."scheduled_request_snapshot"->'version' = '1'::jsonb
    AND jsonb_typeof("agent_trigger_attempts"."scheduled_request_snapshot"->'scheduleId') = 'string'
    AND char_length("agent_trigger_attempts"."scheduled_request_snapshot"->>'scheduleId') BETWEEN 1 AND 256
    AND jsonb_typeof("agent_trigger_attempts"."scheduled_request_snapshot"->'triggerAttemptId') = 'string'
    AND char_length("agent_trigger_attempts"."scheduled_request_snapshot"->>'triggerAttemptId') BETWEEN 1 AND 256
    AND ("agent_trigger_attempts"."scheduled_request_snapshot"->'requestAtLaunch' = 'null'::jsonb OR (
      jsonb_typeof("agent_trigger_attempts"."scheduled_request_snapshot"->'requestAtLaunch') = 'string'
      AND char_length("agent_trigger_attempts"."scheduled_request_snapshot"->>'requestAtLaunch') BETWEEN 1 AND 8000
    ))) ELSE false END) IS TRUE AND ("agent_trigger_attempts"."scheduled_request_snapshot" IS NULL OR ("agent_trigger_attempts"."trigger_source" = 'cron' AND "agent_trigger_attempts"."scheduled_request_snapshot"->>'scheduleId' = "agent_trigger_attempts"."schedule_id" AND "agent_trigger_attempts"."scheduled_request_snapshot"->>'triggerAttemptId' = "agent_trigger_attempts"."id")) IS TRUE);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_scheduled_request_shape" CHECK (("runs"."scheduled_request_snapshot" IS NULL OR CASE WHEN jsonb_typeof("runs"."scheduled_request_snapshot") = 'object' THEN (
    "runs"."scheduled_request_snapshot" ?& ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch']
    AND "runs"."scheduled_request_snapshot" - ARRAY['version','scheduleId','triggerAttemptId','requestAtLaunch'] = '{}'::jsonb
    AND "runs"."scheduled_request_snapshot"->'version' = '1'::jsonb
    AND jsonb_typeof("runs"."scheduled_request_snapshot"->'scheduleId') = 'string'
    AND char_length("runs"."scheduled_request_snapshot"->>'scheduleId') BETWEEN 1 AND 256
    AND jsonb_typeof("runs"."scheduled_request_snapshot"->'triggerAttemptId') = 'string'
    AND char_length("runs"."scheduled_request_snapshot"->>'triggerAttemptId') BETWEEN 1 AND 256
    AND ("runs"."scheduled_request_snapshot"->'requestAtLaunch' = 'null'::jsonb OR (
      jsonb_typeof("runs"."scheduled_request_snapshot"->'requestAtLaunch') = 'string'
      AND char_length("runs"."scheduled_request_snapshot"->>'requestAtLaunch') BETWEEN 1 AND 8000
    ))) ELSE false END) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_trigger_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.source_agent_id, NEW.schedule_id, NEW.binding_snapshot,
         NEW.fence, NEW.delivery_key, NEW.trigger_source, NEW.trigger_event_id,
         NEW.provenance, NEW.reserved_run_id, NEW.claimed_at, NEW.scheduled_request_snapshot)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.source_agent_id, OLD.schedule_id, OLD.binding_snapshot,
         OLD.fence, OLD.delivery_key, OLD.trigger_source, OLD.trigger_event_id,
         OLD.provenance, OLD.reserved_run_id, OLD.claimed_at, OLD.scheduled_request_snapshot) THEN
    RAISE EXCEPTION 'agent trigger attempt identity is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_identity_immutable';
  END IF;
  IF OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown' AND
     ROW(NEW.outcome, NEW.settled_at, NEW.original_run_id, NEW.reason_code)
       IS DISTINCT FROM ROW(OLD.outcome, OLD.settled_at, OLD.original_run_id, OLD.reason_code) THEN
    RAISE EXCEPTION 'settled agent trigger attempt is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='agent_trigger_attempt_settlement_immutable';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION guard_runs_scheduled_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scheduled_request_snapshot IS DISTINCT FROM OLD.scheduled_request_snapshot THEN
    RAISE EXCEPTION 'scheduled request input is immutable for %', OLD.id
      USING ERRCODE='23514', CONSTRAINT='runs_scheduled_request_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_scheduled_request_guard BEFORE UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION guard_runs_scheduled_request();
