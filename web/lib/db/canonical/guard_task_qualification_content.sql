CREATE OR REPLACE FUNCTION public.guard_task_qualification_content()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['publication_state','publication_reason','published_at','author_user_id','author_run_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['publication_state','publication_reason','published_at','author_user_id','author_run_id']) OR (NEW.author_user_id IS DISTINCT FROM OLD.author_user_id AND NEW.author_user_id IS NOT NULL) OR (NEW.author_run_id IS DISTINCT FROM OLD.author_run_id AND NEW.author_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'task qualification assessment is immutable' USING ERRCODE='23514',CONSTRAINT='task_qualification_content_immutable';
  END IF;
  IF ROW(NEW.publication_state,NEW.publication_reason,NEW.published_at) IS DISTINCT FROM ROW(OLD.publication_state,OLD.publication_reason,OLD.published_at) AND (OLD.publication_state<>'candidate' OR NEW.publication_state NOT IN ('accepted','rejected')) THEN
    RAISE EXCEPTION 'task qualification publication is write-once' USING ERRCODE='23514',CONSTRAINT='task_qualification_publication_once';
  END IF;
  RETURN NEW;
END $function$;
