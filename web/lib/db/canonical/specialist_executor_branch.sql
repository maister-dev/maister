CREATE OR REPLACE FUNCTION public.specialist_executor_branch(candidate_id text, candidate_placement text)
 RETURNS TABLE(subject_id text, root_id text, root_placement_id text, root_parked boolean)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT link.assignment_id, root.id, owner_placement.id, root.status='WaitingOnChildren'
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id
    JOIN specialist_assignments subject ON subject.id=link.assignment_id
    JOIN runs root ON root.id=CASE WHEN source.parent_run_id IS NULL THEN source.id ELSE source.root_run_id END
    JOIN execution_assignments actor_placement ON actor_placement.id=source.execution_assignment_id
      AND actor_placement.run_id=source.id AND actor_placement.state='active'
    JOIN execution_assignments owner_placement ON owner_placement.id=root.execution_assignment_id
      AND owner_placement.run_id=root.id
    WHERE source.id=candidate_id AND actor_placement.id=candidate_placement
      AND source.status IN ('Running','NeedsInput')
      AND (actor_placement.lease_expires_at IS NULL OR actor_placement.lease_expires_at>clock_timestamp())
      AND subject.status IN ('active','waiting_input','waiting_children','reconciling')
      AND specialist_current_root_id(subject.id,subject.input_revision)=root.id
      AND ((source.id=root.id AND link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation'))
        OR (source.id<>root.id AND link.work_witness IS NOT NULL))
      AND ((owner_placement.state='active'
        AND (owner_placement.lease_expires_at IS NULL OR owner_placement.lease_expires_at>clock_timestamp()))
        OR (source.id<>root.id AND root.status='WaitingOnChildren'
          AND owner_placement.state='released' AND owner_placement.released_reason='waiting_on_children'))
$function$;
