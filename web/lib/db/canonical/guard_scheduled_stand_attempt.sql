CREATE OR REPLACE FUNCTION public.guard_scheduled_stand_attempt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.stand_inspection IS DISTINCT FROM NEW.stand_inspection THEN
      RAISE EXCEPTION 'Claimed stand appointment is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.stand_inspection IS DISTINCT FROM (
    SELECT source.stand_inspection FROM agent_schedules source WHERE source.id=NEW.schedule_id
  ) OR (NEW.stand_inspection IS NOT NULL AND (NEW.trigger_source<>'cron' OR NEW.company_id IS NULL OR NEW.project_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Cron claim must retain the reviewed stand appointment' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;
