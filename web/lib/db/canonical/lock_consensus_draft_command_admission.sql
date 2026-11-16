CREATE OR REPLACE FUNCTION public.lock_consensus_draft_command_admission(child_run_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE child runs%ROWTYPE;
BEGIN
  PERFORM lock_consensus_draft_command_hierarchy(child_run_id);
  SELECT * INTO child FROM runs WHERE id=child_run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN; END IF;
  PERFORM assert_task_consensus_child_scope(child);
  IF child.status NOT IN ('Running','NeedsInput','NeedsInputIdle') THEN
    RAISE EXCEPTION 'Consensus child command requires its current active execution'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_consensus_child_admission';
  END IF;
END $function$;
