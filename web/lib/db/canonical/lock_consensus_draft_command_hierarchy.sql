CREATE OR REPLACE FUNCTION public.lock_consensus_draft_command_hierarchy(child_run_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE child runs%ROWTYPE;
BEGIN
  SELECT * INTO child FROM runs WHERE id=child_run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN; END IF;
  PERFORM id FROM runs WHERE id=child.parent_run_id FOR UPDATE;
  PERFORM id FROM node_attempts WHERE id=child.task_admission_snapshot->'parent'->>'nodeAttemptId' FOR UPDATE;
  PERFORM id FROM runs WHERE id=child_run_id FOR UPDATE;
END $function$;
