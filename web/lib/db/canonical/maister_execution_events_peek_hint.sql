CREATE OR REPLACE FUNCTION public.maister_execution_events_peek_hint()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.ingest_disposition IS DISTINCT FROM 'accepted' OR NEW.run_sequence IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.ingest_disposition = 'accepted'
    AND OLD.run_sequence IS NOT DISTINCT FROM NEW.run_sequence
    AND OLD.run_id IS NOT DISTINCT FROM NEW.run_id
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'maister_run_peek',
    jsonb_build_object(
      'source', 'execution_events',
      'topic', 'execution',
      'runId', NEW.run_id,
      'parentRunId', NULL,
      'previousParentRunId', NULL,
      'rootRunId', NULL
    )::text
  );
  IF TG_OP = 'UPDATE' AND OLD.run_id IS NOT NULL AND OLD.run_id IS DISTINCT FROM NEW.run_id THEN
    PERFORM pg_notify(
      'maister_run_peek',
      jsonb_build_object(
        'source', 'execution_events',
        'topic', 'execution',
        'runId', OLD.run_id,
        'parentRunId', NULL,
        'previousParentRunId', NULL,
        'rootRunId', NULL
      )::text
    );
  END IF;
  RETURN NULL;
END;
$function$;
