CREATE OR REPLACE FUNCTION public.maister_run_messages_peek_hint()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_run_id text;
  previous_run_id text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.run_id IS DISTINCT FROM NEW.run_id
      OR OLD.node_attempt_id IS DISTINCT FROM NEW.node_attempt_id
      OR OLD.sequence IS DISTINCT FROM NEW.sequence
      OR OLD.role IS DISTINCT FROM NEW.role
      OR OLD.content IS DISTINCT FROM NEW.content
      OR OLD.supervisor_event_id IS DISTINCT FROM NEW.supervisor_event_id
      OR OLD.prompt_dispatch_key IS DISTINCT FROM NEW.prompt_dispatch_key
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_run_id := OLD.run_id;
  ELSE
    target_run_id := NEW.run_id;
    IF TG_OP = 'UPDATE' THEN
      previous_run_id := OLD.run_id;
    END IF;
  END IF;
  PERFORM pg_notify(
    'maister_run_peek',
    jsonb_build_object(
      'source', 'run_messages',
      'topic', 'transcript',
      'runId', target_run_id,
      'parentRunId', NULL,
      'previousParentRunId', NULL,
      'rootRunId', NULL
    )::text
  );
  IF previous_run_id IS NOT NULL AND previous_run_id IS DISTINCT FROM target_run_id THEN
    PERFORM pg_notify(
      'maister_run_peek',
      jsonb_build_object(
        'source', 'run_messages',
        'topic', 'transcript',
        'runId', previous_run_id,
        'parentRunId', NULL,
        'previousParentRunId', NULL,
        'rootRunId', NULL
      )::text
    );
  END IF;
  RETURN NULL;
END;
$function$;
