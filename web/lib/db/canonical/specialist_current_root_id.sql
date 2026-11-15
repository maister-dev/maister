CREATE OR REPLACE FUNCTION public.specialist_current_root_id(subject_id text, selected_input integer)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
