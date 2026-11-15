CREATE OR REPLACE FUNCTION public.guard_project_replacement_event_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.retry_of_run_id IS NOT NULL OR NEW.retry_of_run_id IS NOT NULL) AND
      (ROW(NEW.retry_of_run_id,NEW.project_id,NEW.task_id,NEW.source_agent_id,NEW.trigger_event_id,NEW.trigger_source,NEW.agent_chain_depth)
      IS DISTINCT FROM ROW(OLD.retry_of_run_id,OLD.project_id,OLD.task_id,OLD.source_agent_id,OLD.trigger_event_id,OLD.trigger_source,OLD.agent_chain_depth)
      OR (NEW.agent_schedule_id IS DISTINCT FROM OLD.agent_schedule_id AND NOT (
        NEW.agent_schedule_id IS NULL AND OLD.agent_schedule_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_schedules WHERE id=OLD.agent_schedule_id)))) THEN
      RAISE EXCEPTION 'Project event replacement source identity is immutable'
        USING ERRCODE='23514',CONSTRAINT='project_event_replacement_source_scope';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_retry_intents intent JOIN runs source ON source.id=intent.source_run_id
    WHERE intent.project_id=NEW.project_id AND intent.company_id IS NULL
      AND intent.successor_run_id=NEW.id AND source.id=NEW.retry_of_run_id
      AND intent.state='accepted' AND intent.actor_user_id=NEW.created_by_user_id
      AND source.source_agent_id=NEW.source_agent_id AND source.trigger_event_id=NEW.trigger_event_id
      AND source.agent_schedule_id=NEW.agent_schedule_id AND source.agent_chain_depth=NEW.agent_chain_depth
      AND NEW.trigger_source='domain_event' AND NEW.task_id IS NOT DISTINCT FROM source.task_id
      AND (project_event_retry_source_matches(source.id,intent.actor_user_id,intent.recipe->'replacement'->'event')
        OR project_comment_retry_source_matches(source.id,intent.actor_user_id,intent.recipe->'replacement'->'comment'))
  ) THEN
    RAISE EXCEPTION 'Project event replacement requires its exact accepted original appointment'
      USING ERRCODE='23514',CONSTRAINT='project_event_replacement_source_scope';
  END IF;
  RETURN NEW;
END $function$;
