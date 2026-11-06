ALTER TABLE "runs" ADD COLUMN "company_cancellation_intent" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_company_cancellation_intent_check" CHECK ("runs"."company_cancellation_intent" IS NULL OR ("runs"."company_id" IS NOT NULL AND "runs"."project_id" IS NULL AND jsonb_typeof("runs"."company_cancellation_intent")='object' AND "runs"."company_cancellation_intent"->'version'='1'::jsonb AND "runs"."company_cancellation_intent" ?& array['version','userId','requestedAt','assignmentId','driverToken'] AND "runs"."company_cancellation_intent" - array['version','userId','requestedAt','assignmentId','driverToken']='{}'::jsonb AND jsonb_typeof("runs"."company_cancellation_intent"->'userId')='string' AND char_length("runs"."company_cancellation_intent"->>'userId') BETWEEN 1 AND 128 AND "runs"."company_cancellation_intent"->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND ("runs"."company_cancellation_intent"->'assignmentId'='null'::jsonb OR jsonb_typeof("runs"."company_cancellation_intent"->'assignmentId')='string') AND ("runs"."company_cancellation_intent"->'driverToken'='null'::jsonb OR jsonb_typeof("runs"."company_cancellation_intent"->'driverToken')='string')) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION check_company_cancellation_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.company_cancellation_intent IS NOT NULL AND NEW.company_cancellation_intent IS DISTINCT FROM OLD.company_cancellation_intent THEN
    RAISE EXCEPTION 'Company cancellation intent is immutable' USING ERRCODE='23514', CONSTRAINT='runs_company_cancellation_immutable';
  END IF;
  IF NEW.company_cancellation_intent IS NOT NULL AND NEW.status IN ('Done','Failed') THEN
    RAISE EXCEPTION 'Company cancellation must settle before result completion' USING ERRCODE='23514', CONSTRAINT='runs_company_cancellation_pending';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_company_cancellation_guard BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION check_company_cancellation_intent();
--> statement-breakpoint
CREATE FUNCTION check_company_cancellation_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cancellation jsonb;
BEGIN
  IF NEW.kind IN ('session.create','session.prompt','session.input','session.steer') THEN
    SELECT company_cancellation_intent INTO cancellation FROM runs WHERE id=NEW.run_id FOR UPDATE;
    IF cancellation IS NOT NULL THEN
      RAISE EXCEPTION 'Company cancellation refuses new execution commands' USING ERRCODE='23514', CONSTRAINT='execution_commands_company_cancellation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_company_cancellation_guard BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION check_company_cancellation_command();
