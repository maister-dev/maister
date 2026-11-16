CREATE OR REPLACE FUNCTION public.guard_consensus_child_command_admission()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE child runs%ROWTYPE; assignment execution_assignments%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('session.create','session.prompt') OR NEW.state NOT IN ('queued','delivering') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.state=OLD.state AND NEW.attempts=OLD.attempts AND NEW.max_attempts=OLD.max_attempts THEN RETURN NEW; END IF;
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  IF child.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN NEW; END IF;
  PERFORM lock_consensus_draft_command_admission(child.id);
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  SELECT * INTO assignment FROM execution_assignments WHERE id=NEW.execution_assignment_id FOR SHARE;
  IF assignment.id IS NULL OR assignment.state<>'active' OR child.execution_assignment_id IS DISTINCT FROM assignment.id
    OR assignment.run_id IS DISTINCT FROM child.id OR assignment.epoch<>NEW.assignment_epoch OR assignment.execution_host_id IS DISTINCT FROM NEW.execution_host_id THEN
    RAISE EXCEPTION 'Consensus child command requires its current assignment epoch'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_consensus_assignment_admission';
  END IF;
  RETURN NEW;
END $function$;
