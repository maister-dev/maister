CREATE OR REPLACE FUNCTION public.guard_consensus_child_runner_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE child runs%ROWTYPE;
BEGIN
  SELECT * INTO child FROM runs WHERE id=NEW.run_id;
  IF child.task_admission_snapshot->'version'='3'::jsonb AND (NEW.session_name<>'default' OR NEW.runner_id IS DISTINCT FROM child.task_admission_snapshot->'parent'->>'runnerId') THEN
    RAISE EXCEPTION 'Consensus child session must use its approved participant runner'
      USING ERRCODE='23514',CONSTRAINT='run_sessions_consensus_runner_binding';
  END IF;
  RETURN NEW;
END $function$;
