CREATE OR REPLACE FUNCTION public.maister_run_peek_hint()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_row jsonb;
  previous_row jsonb;
  changed boolean;
  run_id text;
  old_run_id text;
  root_id text;
BEGIN
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN previous_row := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME = 'execution_events' THEN
    IF TG_OP = 'DELETE' OR current_row->>'ingest_disposition' <> 'accepted' OR current_row->>'run_sequence' IS NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND previous_row->>'ingest_disposition' = 'accepted' AND previous_row->>'run_sequence' IS NOT DISTINCT FROM current_row->>'run_sequence' THEN RETURN NULL; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT bool_or(previous_row->key IS DISTINCT FROM current_row->key) INTO changed
      FROM unnest(string_to_array(TG_ARGV[1], ',')) AS key;
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  current_row := coalesce(current_row, previous_row);
  IF TG_TABLE_NAME = 'runs' THEN
    run_id := current_row->>'id';
  ELSE
    run_id := current_row->>'run_id';
    old_run_id := previous_row->>'run_id';
  END IF;
  IF TG_TABLE_NAME = 'workspaces' THEN SELECT coalesce(root_run_id,id) INTO root_id FROM runs WHERE id=run_id; END IF;
  PERFORM pg_notify('maister_run_peek', jsonb_build_object(
    'source', TG_TABLE_NAME, 'topic', TG_ARGV[0], 'runId', run_id,
    'parentRunId', CASE WHEN TG_TABLE_NAME = 'runs' THEN current_row->>'parent_run_id' ELSE NULL END,
    'previousParentRunId', CASE WHEN TG_TABLE_NAME = 'runs' THEN previous_row->>'parent_run_id' ELSE NULL END,
    'rootRunId', CASE WHEN TG_TABLE_NAME = 'runs' THEN current_row->>'root_run_id' ELSE root_id END
  )::text);
  IF old_run_id IS NOT NULL AND old_run_id IS DISTINCT FROM run_id THEN
    PERFORM pg_notify('maister_run_peek', jsonb_build_object('source',TG_TABLE_NAME,'topic',TG_ARGV[0],'runId',old_run_id,'parentRunId',NULL,'previousParentRunId',NULL,'rootRunId',NULL)::text);
  END IF;
  RETURN NULL;
END;
$function$;
