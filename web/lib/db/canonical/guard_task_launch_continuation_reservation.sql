CREATE OR REPLACE FUNCTION public.guard_task_launch_continuation_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.task_launch_intent_id IS NOT NULL AND NEW.status IN ('Running','NeedsInput','HumanWorking')
    AND OLD.status NOT IN ('Running','NeedsInput','HumanWorking') AND NOT EXISTS(
      SELECT 1 FROM task_launch_intents intent WHERE intent.id=NEW.task_launch_intent_id
        AND intent.run_id=NEW.id AND intent.state='run_bound' AND (intent.dispatch_receipt IS NOT NULL OR OLD.status='Pending' AND NEW.run_kind='agent' AND intent.preparation_identity->'version'='2'::jsonb AND intent.settings_snapshot->>'kind'='agent')
    ) THEN
    RAISE EXCEPTION 'Execution continuation must reacquire its original launch reservation'
      USING ERRCODE='23514',CONSTRAINT='task_launch_continuation_reservation';
  END IF;
  RETURN NEW;
END $function$;
