CREATE OR REPLACE FUNCTION public.guard_run_task_launch_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE intent task_launch_intents%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.task_launch_intent_id IS DISTINCT FROM NEW.task_launch_intent_id THEN
    RAISE EXCEPTION 'Run launch authority is write-once'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_immutable';
  END IF;
  IF NEW.task_launch_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO intent FROM task_launch_intents WHERE id=NEW.task_launch_intent_id FOR SHARE;
  IF current_setting('maister.task_launch_writer',true) IS DISTINCT FROM 'v3' OR NOT FOUND
    OR intent.project_id IS DISTINCT FROM NEW.project_id OR intent.task_id IS DISTINCT FROM NEW.task_id
    OR intent.input_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR intent.settings_snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR NEW.resolved_capability_set IS DISTINCT FROM nullif(intent.settings_snapshot->'resolvedCapabilitySet','null'::jsonb)
    OR intent.state<>'preparing' OR intent.lease_expires_at<=clock_timestamp()
    OR NEW.task_admission_snapshot->>'intentId' IS DISTINCT FROM intent.id
    OR NEW.task_admission_snapshot->>'basis' IS DISTINCT FROM intent.basis->>'kind'
    OR NEW.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(intent.input_revision)
    OR NEW.task_admission_snapshot->>'evidenceSha' IS DISTINCT FROM (CASE WHEN intent.basis->>'kind'='automatic' THEN intent.basis->>'evidenceSha' ELSE intent.settings_snapshot->>'baseCommit' END)
    OR NEW.task_admission_snapshot->>'evidenceTarget' IS DISTINCT FROM (CASE WHEN intent.basis->>'kind'='automatic' THEN intent.basis->>'evidenceTarget' ELSE intent.settings_snapshot->>'baseBranch' END)
    OR intent.original_run_id IS NOT NULL AND intent.original_run_id<>NEW.id THEN
    RAISE EXCEPTION 'Run requires its claimed matching launch intent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_binding_required';
  END IF;
  IF intent.basis->>'kind'='automatic' AND (
    NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM intent.basis->>'qualificationId'
    OR NEW.task_admission_snapshot->'qualificationRevision' IS DISTINCT FROM intent.basis->'qualificationRevision'
    OR NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND current_qualification_id=intent.basis->>'qualificationId'
      AND to_jsonb(current_qualification_revision)=intent.basis->'qualificationRevision' AND qualification_input_revision=intent.input_revision)
  ) OR intent.basis->>'kind'='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM intent.basis->'parent' THEN
    RAISE EXCEPTION 'Run admission differs from its accepted qualification or parent'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_basis_required';
  END IF;
  IF NEW.run_kind IS DISTINCT FROM intent.settings_snapshot->>'kind'
    OR NEW.agent_kind='operational' OR NEW.execution_policy IS DISTINCT FROM intent.settings_snapshot->'executionPolicy'
    OR (NEW.run_kind='flow' AND (NEW.flow_id IS DISTINCT FROM intent.settings_snapshot->>'flowId'
      OR NEW.flow_revision_id IS DISTINCT FROM intent.settings_snapshot->>'flowRevisionId'))
    OR (NEW.run_kind='agent' AND (NEW.agent_workspace IS DISTINCT FROM intent.settings_snapshot->>'workspace' OR NEW.agent_id IS DISTINCT FROM intent.settings_snapshot->>'agentId'
      OR NEW.agent_activity_snapshot->>'definitionSha256' IS DISTINCT FROM intent.settings_snapshot->>'definitionSha256')) THEN
    RAISE EXCEPTION 'Run target and execution policy must match the frozen launch settings'
      USING ERRCODE='23514',CONSTRAINT='runs_task_launch_settings_required';
  END IF;
  RETURN NEW;
END $function$;
