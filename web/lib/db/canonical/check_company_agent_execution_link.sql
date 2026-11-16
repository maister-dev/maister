CREATE OR REPLACE FUNCTION public.check_company_agent_execution_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_run_links l JOIN specialist_assignments a ON a.id=l.assignment_id
    WHERE l.run_id=NEW.id AND l.assignment_id=NEW.company_execution_snapshot->'assignment'->>'id'
      AND l.input_revision::numeric=(NEW.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND a.company_id=NEW.company_id AND a.project_id IS NULL
      AND (
        (NEW.parent_run_id IS NULL AND (NEW.company_execution_snapshot->'schemaVersion'='1'::jsonb OR l.role='coordinator'))
        OR (NEW.parent_run_id IS NOT NULL AND l.role='child' AND EXISTS (
          SELECT 1 FROM specialist_work work WHERE work.id=l.work_id AND work.work_revision=l.work_revision
            AND work.child_run_id=NEW.id AND work.reserved_run_id=NEW.id AND work.parent_run_id=NEW.parent_run_id
            AND specialist_run_has_input(NEW.id,a.id,l.input_revision,work.input_sha256)
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Company execution reservation requires its atomic immutable assignment/input link'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_link_check';
  END IF;
  RETURN NULL;
END;
$function$;
