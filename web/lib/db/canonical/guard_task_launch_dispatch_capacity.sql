CREATE OR REPLACE FUNCTION public.guard_task_launch_dispatch_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' AND NEW.task_launch_intent_id IS NOT NULL AND NEW.status<>'Pending' THEN
    RAISE EXCEPTION 'Accepted task runs start Pending before first dispatch'
      USING ERRCODE='23514',CONSTRAINT='task_launch_initial_pending';
  END IF;
  IF TG_OP='INSERT' OR NEW.status IN ('Running','NeedsInput','HumanWorking') AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') THEN
    IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' THEN
      RAISE EXCEPTION 'Task launch writer v3 required for capacity-aware admission; keep older writers stopped during upgrade'
        USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='Pending' AND NEW.status='Running' AND NEW.task_launch_intent_id IS NOT NULL THEN
    SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id;
    IF NOT FOUND OR intent.state<>'run_bound' OR intent.run_id<>NEW.id
      OR (NEW.run_kind<>'agent' AND (intent.dispatch_committed_at IS NULL OR NEW.task_admission_checked_at IS NULL)) THEN
      RAISE EXCEPTION 'Accepted task dispatch must commit its current immutable authority before execution'
        USING ERRCODE='23514',CONSTRAINT='task_launch_dispatch_commit_required';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
