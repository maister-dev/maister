CREATE OR REPLACE FUNCTION public.settle_task_launch_for_terminal_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE current_run runs%ROWTYPE; intent task_launch_intents%ROWTYPE;
BEGIN
  SELECT * INTO current_run FROM runs WHERE id=NEW.id;
  IF NOT FOUND OR current_run.task_launch_intent_id IS NULL OR current_run.status NOT IN ('Done','Failed','Crashed','Abandoned') THEN RETURN NULL; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=current_run.task_launch_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.state IN ('settled','cancelled','failed') THEN RETURN NULL; END IF;
  IF intent.run_id IS DISTINCT FROM current_run.id OR intent.state NOT IN ('run_bound','held','queued','preparing') THEN
    RAISE EXCEPTION 'Terminal execution must settle its own bound launch'
      USING ERRCODE='23514',CONSTRAINT='task_launch_terminal_owner';
  END IF;
  UPDATE task_launch_intents SET state='settled',terminal_outcome=current_run.status,
    state_version=state_version+1,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=intent.id RETURNING * INTO intent;
  INSERT INTO domain_events(project_id,task_id,run_id,kind,actor_type,actor_id,payload,occurred_at)
    VALUES(intent.project_id,intent.task_id,current_run.id,'task.launch_changed','system',NULL,
      jsonb_build_object('intentId',intent.id,'state',intent.state,'stateVersion',intent.state_version,'basis',intent.basis->>'kind'),clock_timestamp());
  RETURN NULL;
END $function$;
