CREATE OR REPLACE FUNCTION public.specialist_run_has_input(source_run text, subject_assignment text, requested_revision integer, requested_digest text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  WITH RECURSIVE retained(revision,digest,depth) AS (
    SELECT input.revision,input.digest,0 FROM specialist_run_links link
    JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id AND input.revision=link.input_revision
    WHERE link.run_id=source_run AND link.assignment_id=subject_assignment AND (
      (link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL AND link.work_witness IS NULL)
      OR (link.role IN ('child','continuation') AND EXISTS (
        SELECT 1 FROM specialist_work work WHERE work.id=link.work_id AND work.work_revision=link.work_revision
          AND work.assignment_id=link.assignment_id AND work.input_revision=link.input_revision AND work.child_run_id=link.run_id
          AND link.work_witness=jsonb_build_object('schemaVersion',1,'id',work.id,'workRevision',work.work_revision,'definitionSha256',work.definition_sha256)
      ))
    )
    UNION ALL
    SELECT next_input.revision,next_input.digest,retained.depth+1 FROM retained
    JOIN hitl_requests question ON question.run_id=source_run AND question.specialist_assignment_id=subject_assignment
      AND question.specialist_input_revision=retained.revision AND question.kind='agent_question'
      AND question.activation_state='active' AND question.responded_at IS NOT NULL AND question.response IS NOT NULL
      AND question.superseded_at IS NULL AND question.specialist_answer IS NOT NULL
    JOIN specialist_input_revisions next_input ON next_input.assignment_id=subject_assignment AND next_input.revision=question.specialist_answer_input_revision
      AND next_input.digest=question.specialist_answer->>'inputSha256'
    WHERE retained.depth<32 AND next_input.revision>retained.revision
  ) SELECT EXISTS(SELECT 1 FROM retained WHERE revision=requested_revision AND digest=requested_digest)
$function$;
