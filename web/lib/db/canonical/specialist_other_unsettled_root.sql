CREATE OR REPLACE FUNCTION public.specialist_other_unsettled_root(subject_id text, candidate_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
