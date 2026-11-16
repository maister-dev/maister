CREATE OR REPLACE FUNCTION public.begin_specialist_executor(candidate_id text, candidate_placement text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  assignment_identity text;
  linked_root text;
  branch record;
  observed_at timestamptz;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT link.assignment_id, CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    INTO assignment_identity,linked_root FROM runs source
    JOIN specialist_run_links link ON link.run_id=source.id
    WHERE source.id=candidate_id AND (
      (source.parent_run_id IS NULL AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
      OR (source.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL)
    )
    FOR NO KEY UPDATE OF source;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF linked_root<>candidate_id AND NOT EXISTS (
    SELECT 1 FROM execution_assignments WHERE run_id=linked_root
  ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=assignment_identity FOR UPDATE;
  IF NOT FOUND THEN RETURN -1; END IF;
  SELECT * INTO branch FROM specialist_executor_branch(candidate_id,candidate_placement);
  IF NOT FOUND OR claim.run_id<>branch.root_id OR claim.placement_id<>branch.root_placement_id THEN
    RETURN -1;
  END IF;
  observed_at := clock_timestamp();
  IF claim.expires_at>observed_at THEN RETURN claim.epoch; END IF;
  IF candidate_id<>branch.root_id AND NOT branch.root_parked THEN RETURN -1; END IF;
  UPDATE specialist_owner_claims SET epoch=claim.epoch+1,renewed_at=observed_at,expires_at=observed_at+interval '120 seconds'
    WHERE assignment_id=assignment_identity AND epoch=claim.epoch RETURNING epoch INTO claim.epoch;
  RETURN claim.epoch;
END $function$;
