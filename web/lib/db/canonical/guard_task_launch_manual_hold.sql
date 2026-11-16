CREATE OR REPLACE FUNCTION public.guard_task_launch_manual_hold()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE held boolean;
BEGIN
  IF NEW.basis->>'kind' IS DISTINCT FROM 'manual'
    OR NEW.state NOT IN ('queued','preparing','run_bound') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.dispatch_committed_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT (triage_status='flagged' AND triage_flag_origin IS DISTINCT FROM 'qualification') IS TRUE
    INTO held FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id FOR UPDATE;
  IF held THEN
    RAISE EXCEPTION 'Manual task launch requires a fresh resolution of its independent hold'
      USING ERRCODE='23514',CONSTRAINT='task_launch_manual_hold';
  END IF;
  RETURN NEW;
END $function$;
