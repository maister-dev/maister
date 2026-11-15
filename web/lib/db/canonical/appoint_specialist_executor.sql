CREATE OR REPLACE FUNCTION public.appoint_specialist_executor(candidate_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  subject_id text;
  current_input integer;
  owner_placement text;
  observed_at timestamptz := clock_timestamp();
BEGIN
  SELECT link.assignment_id, subject.input_revision, placement.id
    INTO subject_id,current_input,owner_placement
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN execution_assignments placement ON placement.id=source.execution_assignment_id
      AND placement.run_id=source.id AND placement.state='active'
    WHERE source.id=candidate_id AND source.parent_run_id IS NULL
      AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation')
      AND source.status IN ('Pending','Running','NeedsInput')
      AND (placement.lease_expires_at IS NULL OR placement.lease_expires_at>observed_at)
    FOR NO KEY UPDATE OF subject NOWAIT;
  IF NOT FOUND OR specialist_current_root_id(subject_id,current_input) IS DISTINCT FROM candidate_id THEN
    RETURN;
  END IF;
  INSERT INTO specialist_owner_claims(assignment_id,run_id,placement_id,epoch,renewed_at,expires_at)
    VALUES(subject_id,candidate_id,owner_placement,1,observed_at,observed_at+interval '120 seconds')
    ON CONFLICT(assignment_id) DO UPDATE
    SET run_id=excluded.run_id,placement_id=excluded.placement_id,
      epoch=specialist_owner_claims.epoch+1,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at
    WHERE specialist_owner_claims.placement_id<>excluded.placement_id;
END $function$;
