-- Transactional advisory invalidation only. No source rows are rewritten.
CREATE FUNCTION public.maister_run_peek_hint() RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE TRIGGER runs_peek_hint AFTER INSERT OR UPDATE OR DELETE ON runs FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('summary','project_id,parent_run_id,root_run_id,task_id,run_kind,status,agent_kind,agent_activity_snapshot,delegation_snapshot,result_contract,current_step_id,workspace_mode,agent_workspace,launched_at,started_at,ended_at');
--> statement-breakpoint
CREATE TRIGGER run_results_peek_hint AFTER INSERT OR UPDATE OR DELETE ON run_results FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('summary','run_id,revision,validity,schema_ref,schema_version,value,value_bytes,invalid_reason,first_collected_at');
--> statement-breakpoint
CREATE TRIGGER workspaces_peek_hint AFTER INSERT OR UPDATE OR DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('summary','run_id,removed_at');
--> statement-breakpoint
CREATE TRIGGER execution_events_peek_hint AFTER INSERT OR UPDATE OR DELETE ON execution_events FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('execution','run_id,run_sequence,ingest_disposition');
--> statement-breakpoint
CREATE TRIGGER node_attempts_peek_hint AFTER INSERT OR UPDATE OR DELETE ON node_attempts FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('execution','run_id,node_id,node_type,attempt,status,decision,error_code,started_at,ended_at');
--> statement-breakpoint
CREATE TRIGGER run_messages_peek_hint AFTER INSERT OR UPDATE OR DELETE ON run_messages FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint('transcript','run_id,node_attempt_id,sequence,role,content,supervisor_event_id,prompt_dispatch_key,created_at');
