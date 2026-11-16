CREATE OR REPLACE FUNCTION public.guard_task_launch_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE guarded boolean;
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    guarded:=NEW.task_launch_intent_id IS NOT NULL;
  ELSE
    SELECT EXISTS(SELECT 1 FROM task_launch_intents WHERE task_id=NEW.id AND state IN ('queued','preparing','run_bound','held')) INTO guarded;
  END IF;
  IF guarded AND current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' THEN
    RAISE EXCEPTION 'Task launch writer v3 required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_launch_writer_capability';
  END IF;
  RETURN NEW;
END $function$;
