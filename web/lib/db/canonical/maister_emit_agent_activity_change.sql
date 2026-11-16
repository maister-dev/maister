CREATE OR REPLACE FUNCTION public.maister_emit_agent_activity_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.project_id IS NOT NULL AND (NEW.run_kind='agent' OR NEW.source_agent_id IS NOT NULL)
    AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.checkpoint_at IS DISTINCT FROM OLD.checkpoint_at
      OR NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id) THEN
    INSERT INTO domain_events(kind,project_id,run_id,actor_type,occurred_at,payload)
    VALUES ('agent.activity_changed',NEW.project_id,NEW.id,'system',clock_timestamp(),
      jsonb_build_object('projectId',NEW.project_id,'agentId',NEW.source_agent_id,
        'runId',NEW.id,'status',NEW.status));
  END IF;
  RETURN NEW;
END $function$;
