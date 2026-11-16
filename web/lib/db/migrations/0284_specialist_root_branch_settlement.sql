CREATE OR REPLACE FUNCTION specialist_other_unsettled_root(subject_id text, candidate_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM specialist_run_links link
    JOIN runs prior ON prior.id=link.run_id
    WHERE link.assignment_id=subject_id AND prior.id<>candidate_id
      AND (
        (prior.parent_run_id IS NULL AND link.work_id IS NULL
          AND link.role IN ('specialist','coordinator','continuation'))
        OR (prior.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL
          AND prior.root_run_id IS DISTINCT FROM candidate_id)
      )
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
CREATE OR REPLACE FUNCTION inspect_specialist_root_recovery(candidate_id text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  subject_id text;
  execution_root_id text;
  subject specialist_assignments%ROWTYPE;
BEGIN
  SELECT link.assignment_id,
      CASE WHEN candidate.parent_run_id IS NULL THEN candidate.id ELSE candidate.root_run_id END
    INTO subject_id,execution_root_id
    FROM specialist_run_links link JOIN runs candidate ON candidate.id=link.run_id
    WHERE link.run_id=candidate_id AND (
      (candidate.parent_run_id IS NULL AND link.work_id IS NULL
        AND link.role IN ('specialist','coordinator','continuation'))
      OR (candidate.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL)
    );
  IF NOT FOUND THEN
    RETURN 'allowed';
  END IF;
  -- Recover already holds the Run row. Admission holds the assignment first.
  SELECT * INTO subject FROM specialist_assignments WHERE id=subject_id
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 'busy';
  END IF;
  IF subject.status IN ('completed','failed','cancelled','awaiting_acceptance')
    OR execution_root_id IS NULL
    OR specialist_current_root_id(subject.id,subject.input_revision) IS DISTINCT FROM execution_root_id
    OR specialist_other_unsettled_root(subject.id,execution_root_id) THEN
    RETURN 'conflict';
  END IF;
  RETURN 'allowed';
END $$;
