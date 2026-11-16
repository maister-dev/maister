CREATE OR REPLACE FUNCTION public.guard_task_launch_parent_observation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' AND NEW.parent_observed_version IS NOT NULL THEN
    RAISE EXCEPTION 'A new accepted request has not been observed by its parent'
      USING ERRCODE='23514',CONSTRAINT='task_launch_parent_observation_initial';
  END IF;
  IF TG_OP='UPDATE' AND NEW.parent_observed_version IS DISTINCT FROM OLD.parent_observed_version THEN
    IF NEW.parent_observed_version IS NULL OR NEW.parent_observed_version IS DISTINCT FROM OLD.state_version
      OR OLD.parent_observed_version IS NOT NULL AND NEW.parent_observed_version<OLD.parent_observed_version
      OR to_jsonb(NEW)-'parent_observed_version' IS DISTINCT FROM to_jsonb(OLD)-'parent_observed_version'
      OR NOT EXISTS(SELECT 1 FROM runs parent
        JOIN node_attempts attempt ON attempt.run_id=parent.id AND attempt.node_id=parent.current_step_id
        JOIN execution_commands command ON command.id=attempt.action_completion->>'commandId'
        WHERE parent.id=OLD.basis->'parent'->>'parentRunId' AND parent.project_id=OLD.project_id
          AND parent.status='Running' AND attempt.node_type='orchestrator' AND attempt.status='Running'
          AND command.run_id=parent.id AND command.state='succeeded' AND command.application_state='applied'
          AND command.coordinator_child_launch_context->>'requestSha256'=command.request_sha256
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(command.coordinator_child_launch_context->'receipts') receipt
            WHERE receipt->>'intentId'=OLD.id AND receipt->>'taskId'=OLD.task_id
              AND receipt->>'state'=OLD.state AND receipt->'stateVersion'=to_jsonb(OLD.state_version))) THEN
      RAISE EXCEPTION 'Only the exact completed coordinator input can observe this terminal request'
        USING ERRCODE='23514',CONSTRAINT='task_launch_parent_observation_owner';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
