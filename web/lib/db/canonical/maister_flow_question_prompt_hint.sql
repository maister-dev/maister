CREATE OR REPLACE FUNCTION public.maister_flow_question_prompt_hint()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  run_key text;
BEGIN
  IF TG_TABLE_NAME = 'project_tokens' THEN
    run_key := NEW.bound_run_id;
  ELSE
    run_key := NEW.run_id;
  END IF;

  PERFORM pg_notify('maister_flow_question_prompt', jsonb_build_object(
    'source', TG_TABLE_NAME, 'runId', run_key, 'id', NEW.id
  )::text);
  RETURN NULL;
END;
$function$;
