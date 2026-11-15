CREATE OR REPLACE FUNCTION public.assert_taskless_agent_carrier_scope(candidate runs)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE target tasks%ROWTYPE; witness jsonb:=candidate.task_admission_snapshot->'carrier'; frozen jsonb:=witness->'inputSnapshot';
BEGIN
  SELECT * INTO target FROM tasks WHERE id=candidate.task_id AND project_id=candidate.project_id FOR SHARE;
  IF NOT FOUND OR candidate.run_kind<>'flow' OR candidate.agent_id IS NULL OR candidate.task_launch_intent_id IS NOT NULL
    OR candidate.created_by_user_id IS NOT NULL OR candidate.parent_run_id IS NOT NULL
    OR target.created_by_user_id IS NOT NULL OR target.revision<>0 OR target.attempt_number<>1
    OR target.agent_id IS DISTINCT FROM candidate.agent_id OR target.flow_id IS DISTINCT FROM candidate.flow_id
    OR target.trigger_event_id IS DISTINCT FROM candidate.trigger_event_id
    OR candidate.task_admission_snapshot->>'mode' IS DISTINCT FROM 'legacy'
    OR witness->>'agentId' IS DISTINCT FROM candidate.agent_id
    OR NOT (witness->>'metadataDigest' ~ '^[a-f0-9]{64}$') IS TRUE
    OR witness-ARRAY['inputSnapshot','inputDigest','agentId','metadataDigest']<>'{}'::jsonb
    OR jsonb_typeof(frozen) IS DISTINCT FROM 'object' OR frozen->'version' IS DISTINCT FROM '2'::jsonb
    OR frozen->>'projectId' IS DISTINCT FROM candidate.project_id OR frozen->>'taskId' IS DISTINCT FROM candidate.task_id
    OR frozen->>'title' IS DISTINCT FROM target.title OR frozen->>'prompt' IS DISTINCT FROM target.prompt
    OR frozen->'statementRevision' IS DISTINCT FROM coalesce(to_jsonb(target.statement_revision),'null'::jsonb)
    OR jsonb_typeof(frozen->'clarifications') IS DISTINCT FROM 'array' OR jsonb_array_length(frozen->'clarifications')<>0
    OR task_launch_admission_digest(frozen) IS DISTINCT FROM witness->>'inputDigest'
    OR candidate.task_admission_snapshot->'inputRevision' IS DISTINCT FROM to_jsonb(target.qualification_input_revision)
    OR EXISTS(SELECT 1 FROM runs WHERE task_id=candidate.task_id)
    OR EXISTS(SELECT 1 FROM task_launch_intents WHERE task_id=candidate.task_id) THEN
    RAISE EXCEPTION 'Taskless agent carrier requires its one fresh generated input'
      USING ERRCODE='23514',CONSTRAINT='runs_taskless_agent_carrier_scope';
  END IF;
END $function$;
