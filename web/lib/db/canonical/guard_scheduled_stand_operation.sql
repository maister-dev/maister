CREATE OR REPLACE FUNCTION public.guard_scheduled_stand_operation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM specialist_assignments subject
    JOIN agent_trigger_attempts invocation ON invocation.id=subject.origin->>'triggerAttemptId'
      AND invocation.schedule_id=subject.origin->>'scheduleId'
    WHERE subject.id=NEW.assignment_id AND subject.origin->>'kind'='schedule'
      AND invocation.stand_inspection IS NOT NULL
      AND (NEW.action<>'inspect' OR NEW.target_id<>invocation.stand_inspection->>'targetId'
        OR NEW.component_id<>invocation.stand_inspection->>'componentId'
        OR to_jsonb(NEW.config_revision)<>invocation.stand_inspection->'configRevision'
        OR NEW.target_incarnation<>invocation.stand_inspection->>'incarnationId')
  ) THEN
    RAISE EXCEPTION 'A scheduled stand operation must be a read of the exact appointed component'
      USING ERRCODE='23514',CONSTRAINT='stand_operations_scheduled_appointment';
  END IF;
  RETURN NEW;
END $function$;
