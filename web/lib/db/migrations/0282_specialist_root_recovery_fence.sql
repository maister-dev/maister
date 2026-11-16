CREATE FUNCTION specialist_other_unsettled_root(subject_id text, candidate_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM specialist_run_links link
    JOIN runs prior ON prior.id=link.run_id
    WHERE link.assignment_id=subject_id AND prior.id<>candidate_id
      AND prior.parent_run_id IS NULL AND link.work_id IS NULL
      AND link.role IN ('specialist','coordinator','continuation')
      AND (prior.status NOT IN ('Done','Failed','Crashed','Abandoned') OR (
        prior.status='Crashed' AND EXISTS (
          SELECT 1 FROM execution_assignments placement
          WHERE placement.id=prior.execution_assignment_id AND placement.run_id=prior.id
            AND placement.state='active'
        )
      ))
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION specialist_root_link_conflicts(subject_id text, candidate_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs candidate WHERE candidate.id=candidate_id
      AND candidate.parent_run_id IS NULL
      AND candidate.status NOT IN ('Done','Failed','Crashed','Abandoned')
  ) AND specialist_other_unsettled_root(subject_id, candidate_id)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_root_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_id IS NOT NULL OR NEW.role='child' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM specialist_assignments WHERE id=NEW.assignment_id FOR UPDATE;
  PERFORM 1 FROM runs WHERE id=NEW.run_id FOR SHARE;
  IF specialist_root_link_conflicts(NEW.assignment_id, NEW.run_id) THEN
    RAISE EXCEPTION 'Settle the current root execution before appointing a replacement'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignment_root_unsettled';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION inspect_specialist_root_recovery(candidate_id text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  appointment specialist_run_links%ROWTYPE;
  subject specialist_assignments%ROWTYPE;
BEGIN
  SELECT link.* INTO appointment FROM specialist_run_links link
    JOIN runs candidate ON candidate.id=link.run_id
    WHERE link.run_id=candidate_id AND candidate.parent_run_id IS NULL
      AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation');
  IF NOT FOUND THEN
    RETURN 'allowed';
  END IF;
  -- Recover already holds the Run row. Admission holds the assignment first.
  SELECT * INTO subject FROM specialist_assignments WHERE id=appointment.assignment_id
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 'busy';
  END IF;
  IF appointment.input_revision<>subject.input_revision
    OR subject.status IN ('completed','failed','cancelled','awaiting_acceptance')
    OR specialist_other_unsettled_root(subject.id, candidate_id) THEN
    RETURN 'conflict';
  END IF;
  RETURN 'allowed';
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_specialist_root_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  CASE inspect_specialist_root_recovery(OLD.id)
    WHEN 'allowed' THEN RETURN NEW;
    WHEN 'busy' THEN RAISE EXCEPTION 'Assignment admission or review holds the current appointment'
      USING ERRCODE='55P03';
    ELSE RAISE EXCEPTION 'The retained Run is not eligible to recover the current assignment'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignment_root_recovery_conflict';
  END CASE;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_root_recovery_guard BEFORE UPDATE OF status ON runs
FOR EACH ROW WHEN (OLD.status='Crashed' AND NEW.status IN ('Pending','Running'))
EXECUTE FUNCTION guard_specialist_root_recovery();
