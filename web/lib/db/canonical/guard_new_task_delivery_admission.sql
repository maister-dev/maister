CREATE OR REPLACE FUNCTION public.guard_new_task_delivery_admission()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE target tasks%ROWTYPE;
BEGIN
  IF NEW.task_admission_snapshot ? 'carrier' THEN
    PERFORM assert_taskless_agent_carrier_scope(NEW);
    RETURN NEW;
  END IF;
  IF NEW.task_admission_snapshot->'version'='3'::jsonb THEN
    PERFORM assert_task_consensus_child_scope(NEW);
    RETURN NEW;
  END IF;
  IF NEW.task_launch_intent_id IS NOT NULL THEN
    -- The intent binding guard validates stored basis, input, lease and scope.
    -- v1 remains byte-compatible until the coordinated v2 writer cutover.
    RETURN NEW;
  END IF;
  IF NEW.task_id IS NULL OR NEW.agent_kind='operational' THEN RETURN NEW; END IF;
  SELECT * INTO target FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id;
  IF NOT FOUND OR target.qualification_mode='legacy' THEN RETURN NEW; END IF;
  IF NEW.task_admission_snapshot IS NULL OR NEW.task_admission_snapshot->>'mode' IS DISTINCT FROM target.qualification_mode
    OR (NEW.task_admission_snapshot->>'inputRevision')::int<>target.qualification_input_revision
    OR (target.qualification_mode='required' AND (NEW.task_admission_snapshot->>'qualificationId' IS DISTINCT FROM target.current_qualification_id
      OR (NEW.task_admission_snapshot->>'qualificationRevision')::int IS DISTINCT FROM target.current_qualification_revision))
    OR (target.qualification_mode='execution_child' AND NEW.task_admission_snapshot->'parent' IS DISTINCT FROM target.qualification_child_proof) THEN
    RAISE EXCEPTION 'delivery admission must bind the current task qualification'
      USING ERRCODE='23514',CONSTRAINT='runs_task_delivery_admission_required';
  END IF;
  RETURN NEW;
END $function$;
