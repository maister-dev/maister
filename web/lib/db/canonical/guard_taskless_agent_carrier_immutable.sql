CREATE OR REPLACE FUNCTION public.guard_taskless_agent_carrier_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.task_admission_snapshot ? 'carrier' AND NOT coalesce(OLD.task_admission_snapshot ? 'carrier',false) THEN
    RAISE EXCEPTION 'Taskless carrier admission is established only at creation'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_carrier_admission_immutable';
  END IF;
  IF OLD.task_admission_snapshot ? 'carrier' AND (
    OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot
    OR (OLD.project_id,OLD.task_id,OLD.agent_id,OLD.flow_id,OLD.created_by_user_id,OLD.trigger_event_id,OLD.parent_run_id)
      IS DISTINCT FROM (NEW.project_id,NEW.task_id,NEW.agent_id,NEW.flow_id,NEW.created_by_user_id,NEW.trigger_event_id,NEW.parent_run_id)) THEN
    RAISE EXCEPTION 'Taskless carrier admission and source are immutable'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_carrier_admission_immutable';
  END IF;
  RETURN NEW;
END $function$;
