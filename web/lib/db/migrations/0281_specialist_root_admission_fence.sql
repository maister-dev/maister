CREATE FUNCTION specialist_root_link_conflicts(subject_id text, candidate_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs candidate
    JOIN specialist_run_links link ON link.assignment_id=subject_id
    JOIN runs prior ON prior.id=link.run_id
    WHERE candidate.id=candidate_id AND candidate.parent_run_id IS NULL
      AND candidate.status NOT IN ('Done','Failed','Crashed','Abandoned')
      AND prior.id<>candidate.id AND prior.parent_run_id IS NULL
      AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation')
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
CREATE FUNCTION guard_specialist_root_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_id IS NOT NULL OR NEW.role='child' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM specialist_assignments WHERE id=NEW.assignment_id FOR UPDATE;
  IF specialist_root_link_conflicts(NEW.assignment_id, NEW.run_id) THEN
    RAISE EXCEPTION 'Settle the current root execution before appointing a replacement'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignment_root_unsettled';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_root_link_guard BEFORE INSERT ON specialist_run_links
FOR EACH ROW EXECUTE FUNCTION guard_specialist_root_link();
