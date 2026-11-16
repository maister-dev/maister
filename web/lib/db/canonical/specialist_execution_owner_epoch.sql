CREATE OR REPLACE FUNCTION public.specialist_execution_owner_epoch(candidate_id text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  subject_id text;
  current_input integer;
  root_id text;
  root_placement text;
  root_status text;
  claim specialist_owner_claims%ROWTYPE;
BEGIN
  SELECT subject.id,subject.input_revision,root.id,root.execution_assignment_id,root.status
    INTO subject_id,current_input,root_id,root_placement,root_status
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    LEFT JOIN runs root ON root.id=CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    WHERE source.id=candidate_id AND (
      (source.parent_run_id IS NULL AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
      OR (source.parent_run_id IS NOT NULL AND link.work_witness IS NOT NULL)
    );
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF root_id IS NULL OR specialist_current_root_id(subject_id,current_input) IS DISTINCT FROM root_id THEN
    RETURN -1;
  END IF;
  SELECT * INTO claim FROM specialist_owner_claims WHERE assignment_id=subject_id FOR SHARE;
  IF NOT FOUND AND root_placement IS NULL AND NOT EXISTS (
    SELECT 1 FROM execution_assignments WHERE run_id=root_id
  ) THEN
    RETURN NULL;
  END IF;
  IF claim.run_id IS DISTINCT FROM root_id OR claim.placement_id IS DISTINCT FROM root_placement
    OR claim.expires_at<=clock_timestamp() OR NOT EXISTS (
      SELECT 1 FROM execution_assignments placement WHERE placement.id=root_placement
        AND ((placement.state='active' AND (placement.lease_expires_at IS NULL OR placement.lease_expires_at>clock_timestamp()))
          OR (candidate_id<>root_id AND root_status='WaitingOnChildren'
            AND placement.state='released' AND placement.released_reason='waiting_on_children'))
    ) THEN
    RETURN -1;
  END IF;
  RETURN claim.epoch;
END $function$;
