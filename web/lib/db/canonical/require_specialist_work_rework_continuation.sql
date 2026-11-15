CREATE OR REPLACE FUNCTION public.require_specialist_work_rework_continuation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.decision='accept' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='accepted'
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'entry',jsonb_build_object('kind','accepted','acceptedWork',jsonb_build_object('decisionId',NEW.id))
        ))
    ) THEN
      RAISE EXCEPTION 'Work acceptance requires its exact accepted working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_acceptance_context_required';
    END IF;
    RETURN NEW;
  ELSIF NEW.decision='reject' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='rejected'
        AND history.input_revision=NEW.input_revision AND history.actor=NEW.actor
        AND history.request_key='reject-'||NEW.id AND history.request_digest=NEW.request_sha256
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'actor',NEW.actor,'introducedRevision',history.revision,
          'entry',jsonb_build_object('id',NEW.id,'kind','decision','state','resolved','text',NEW.reason)
        ))
    ) THEN
      RAISE EXCEPTION 'Work rejection requires its exact attributed working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_rejection_context_required';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_work prior JOIN specialist_work continuation
      ON continuation.id=prior.id AND continuation.work_revision=prior.work_revision+1
    WHERE prior.id=NEW.work_id AND prior.work_revision=NEW.work_revision
      AND prior.decision_state='rework_requested'
      AND (NEW.interruption_command_id IS NULL OR (continuation.input_revision=prior.input_revision
        AND continuation.input_sha256=prior.input_sha256
        AND continuation.definition->'objectiveInput'=prior.definition->'objectiveInput'))
  ) THEN
    RAISE EXCEPTION 'A rework decision requires its next retained work definition'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_rework_continuation_required';
  END IF;
  RETURN NEW;
END $function$;
