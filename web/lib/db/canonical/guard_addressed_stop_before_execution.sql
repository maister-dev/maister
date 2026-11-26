CREATE OR REPLACE FUNCTION public.guard_addressed_stop_before_execution()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE stop_requested boolean;
DECLARE ancestor_stopped boolean;
BEGIN
  IF NEW.kind NOT IN ('workspace.prepare', 'workspace.materialize', 'workspace.run',
    'session.create', 'session.prompt', 'session.input', 'session.steer') THEN
    RETURN NEW;
  END IF;
  SELECT addressed_stop_requested_at IS NOT NULL INTO stop_requested
  FROM execution_assignments WHERE id = NEW.execution_assignment_id FOR SHARE;
  WITH RECURSIVE ancestors AS (
      SELECT parent.id,parent.parent_run_id,parent.execution_assignment_id FROM runs child
      JOIN runs parent ON parent.id=child.parent_run_id WHERE child.id=NEW.run_id
      UNION
      SELECT parent.id,parent.parent_run_id,parent.execution_assignment_id
      FROM runs parent JOIN ancestors child ON parent.id=child.parent_run_id
    )
  SELECT bool_or(requested) INTO ancestor_stopped FROM (
    SELECT owner.addressed_stop_requested_at IS NOT NULL AS requested
    FROM ancestors JOIN execution_assignments owner ON owner.id=ancestors.execution_assignment_id
    ORDER BY owner.id FOR SHARE OF owner
  ) locked;
  IF stop_requested OR ancestor_stopped THEN
    RAISE EXCEPTION 'Addressed Stop holds the execution assignment or an ancestor'
      USING ERRCODE = '23514', CONSTRAINT = 'addressed_stop_pending';
  END IF;
  RETURN NEW;
END $function$;
