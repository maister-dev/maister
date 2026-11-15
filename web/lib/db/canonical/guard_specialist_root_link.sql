CREATE OR REPLACE FUNCTION public.guard_specialist_root_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_input integer;
  candidate runs%ROWTYPE;
BEGIN
  -- Only a live root appointment earns an epoch. Imports retain their history.
  NEW.root_appointment_epoch := NULL;
  IF NEW.work_id IS NOT NULL OR NEW.role='child' THEN
    RETURN NEW;
  END IF;
  SELECT input_revision INTO current_input FROM specialist_assignments
    WHERE id=NEW.assignment_id FOR UPDATE;
  SELECT * INTO candidate FROM runs WHERE id=NEW.run_id FOR SHARE;
  IF NOT FOUND OR candidate.parent_run_id IS NOT NULL
    OR candidate.status IN ('Done','Failed','Crashed','Abandoned') THEN
    RETURN NEW;
  END IF;
  IF NEW.input_revision IS DISTINCT FROM current_input
    OR specialist_root_link_conflicts(NEW.assignment_id, NEW.run_id) THEN
    RAISE EXCEPTION 'Root appointment requires current input and settled prior work'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignment_root_unsettled';
  END IF;
  SELECT COALESCE(max(root_appointment_epoch),0)+1 INTO NEW.root_appointment_epoch
    FROM specialist_run_links WHERE assignment_id=NEW.assignment_id;
  RETURN NEW;
END $function$;
