CREATE OR REPLACE FUNCTION public.specialist_root_link_conflicts(subject_id text, candidate_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs candidate WHERE candidate.id=candidate_id
      AND candidate.parent_run_id IS NULL
      AND candidate.status NOT IN ('Done','Failed','Crashed','Abandoned')
  ) AND (
    EXISTS (SELECT 1 FROM specialist_assignments subject WHERE subject.id=subject_id
      AND subject.status IN ('awaiting_acceptance','completed','failed','cancelled'))
    OR specialist_other_unsettled_root(subject_id, candidate_id)
  )
$function$;
