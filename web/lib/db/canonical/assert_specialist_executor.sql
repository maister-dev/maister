CREATE OR REPLACE FUNCTION public.assert_specialist_executor(candidate_id text, candidate_placement text, expected_epoch integer)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_owner_claims claim ON claim.assignment_id=link.assignment_id
    JOIN runs root ON root.id=claim.run_id AND root.execution_assignment_id=claim.placement_id
    WHERE source.id=candidate_id AND source.execution_assignment_id=candidate_placement
      AND (source.id=root.id OR source.root_run_id=root.id)
      AND claim.epoch=expected_epoch AND claim.expires_at>clock_timestamp()
    FOR SHARE OF claim
  )
$function$;
