CREATE OR REPLACE FUNCTION public.renew_specialist_executor(candidate_id text, candidate_placement text, expected_epoch integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  observed_at timestamptz := clock_timestamp();
  branch record;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT * INTO branch FROM specialist_executor_branch(candidate_id,candidate_placement);
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=branch.subject_id;
  IF NOT FOUND OR claim.epoch<>expected_epoch OR claim.run_id<>branch.root_id
    OR claim.placement_id<>branch.root_placement_id OR claim.expires_at<=observed_at THEN
    RETURN false;
  END IF;
  IF (candidate_id<>branch.root_id AND NOT branch.root_parked)
    OR claim.renewed_at>observed_at-interval '40 seconds' THEN RETURN true; END IF;
  UPDATE specialist_owner_claims SET renewed_at=observed_at,expires_at=observed_at+interval '120 seconds'
    WHERE assignment_id=claim.assignment_id AND run_id=branch.root_id AND placement_id=branch.root_placement_id
      AND epoch=claim.epoch AND expires_at>clock_timestamp()
      AND renewed_at<=observed_at-interval '40 seconds';
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM specialist_owner_claims
    WHERE assignment_id=claim.assignment_id AND epoch=expected_epoch AND expires_at>clock_timestamp());
END $function$;
