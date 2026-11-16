ALTER TABLE "specialist_run_links" ADD COLUMN "root_appointment_epoch" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_run_links_root_appointment_uq" ON "specialist_run_links" USING btree ("assignment_id","root_appointment_epoch") WHERE "specialist_run_links"."root_appointment_epoch" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "specialist_run_links" ADD CONSTRAINT "specialist_run_links_root_appointment_check" CHECK ("specialist_run_links"."root_appointment_epoch" IS NULL OR ("specialist_run_links"."root_appointment_epoch">0 AND "specialist_run_links"."work_id" IS NULL AND "specialist_run_links"."role" IN ('specialist','coordinator','continuation')));
--> statement-breakpoint
CREATE FUNCTION specialist_current_root_id(subject_id text, selected_input integer)
RETURNS text LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT link.run_id FROM specialist_run_links link
    WHERE link.assignment_id=subject_id AND link.root_appointment_epoch IS NOT NULL
    ORDER BY link.root_appointment_epoch DESC LIMIT 1
  )
  SELECT min(link.run_id) FROM specialist_run_links link
  JOIN runs source ON source.id=link.run_id
  JOIN specialist_input_revisions input ON input.assignment_id=subject_id AND input.revision=selected_input
  WHERE link.assignment_id=subject_id AND link.work_id IS NULL
    AND link.role IN ('specialist','coordinator','continuation') AND source.parent_run_id IS NULL
    AND (NOT EXISTS (SELECT 1 FROM latest) OR link.run_id=(SELECT run_id FROM latest))
    AND specialist_run_has_input(link.run_id,subject_id,selected_input,input.digest)
  HAVING count(*)=1
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION specialist_root_link_conflicts(subject_id text, candidate_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM runs candidate WHERE candidate.id=candidate_id
      AND candidate.parent_run_id IS NULL
      AND candidate.status NOT IN ('Done','Failed','Crashed','Abandoned')
  ) AND (
    EXISTS (SELECT 1 FROM specialist_assignments subject WHERE subject.id=subject_id
      AND subject.status IN ('awaiting_acceptance','completed','failed','cancelled'))
    OR specialist_other_unsettled_root(subject_id, candidate_id)
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_root_link() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inspect_specialist_root_recovery(candidate_id text)
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
  IF subject.status IN ('completed','failed','cancelled','awaiting_acceptance')
    OR specialist_current_root_id(subject.id,subject.input_revision) IS DISTINCT FROM candidate_id
    OR specialist_other_unsettled_root(subject.id, candidate_id) THEN
    RETURN 'conflict';
  END IF;
  RETURN 'allowed';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION specialist_final_result_id(subject_id text, selected_input integer, selected_run text, selected_result integer)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT result.id
  FROM specialist_assignments subject
  JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=selected_input
  JOIN specialist_run_links link ON link.assignment_id=subject.id AND link.run_id=selected_run
  JOIN runs source ON source.id=link.run_id
  JOIN run_results result ON result.run_id=source.id AND result.revision=selected_result
  WHERE subject.id=subject_id AND subject.input_revision=selected_input
    AND specialist_current_root_id(subject.id,selected_input)=selected_run
    AND NOT specialist_other_unsettled_root(subject.id,selected_run)
    AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL
    AND source.parent_run_id IS NULL AND source.status='Done'
    AND source.project_id IS NOT DISTINCT FROM subject.project_id
    AND source.company_id IS NOT DISTINCT FROM subject.company_id
    AND source.knowledge_access->>'state'='complete'
    AND result.validity='valid' AND result.value IS NOT NULL
    AND source.result_contract->'required'='true'::jsonb
    AND input.objective_input->'expectedResult'->'required'='true'::jsonb
    AND result.schema_ref=input.objective_input->'expectedResult'->>'schemaRef'
    AND result.schema_version::text=input.objective_input->'expectedResult'->>'schemaVersion'
    AND result.schema_sha256=input.objective_input->'expectedResult'->>'sha256'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(input.objective_input->'verification') requirement
      WHERE requirement->'required'='true'::jsonb AND (
        requirement->>'kind' IS DISTINCT FROM 'result'
        OR (requirement->>'referenceId' IS NOT NULL AND requirement->>'referenceId'<>result.id)
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM specialist_work work LEFT JOIN runs child ON child.id=work.child_run_id
      WHERE work.assignment_id=subject.id AND work.input_revision=selected_input AND work.decision_state='open'
        AND (child.id IS NULL OR child.status NOT IN ('Done','Failed','Crashed','Abandoned'))
    )
$$;
