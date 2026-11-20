CREATE OR REPLACE FUNCTION public.agent_memory_capture_external_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME='task_external_sources' THEN
    INSERT INTO agent_memory_external_tasks(task_id) VALUES (NEW.task_id) ON CONFLICT DO NOTHING;
  ELSIF NEW.trigger_source='webhook' THEN
    INSERT INTO agent_memory_tainted_runs(run_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$function$;
