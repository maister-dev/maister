CREATE OR REPLACE FUNCTION public.guard_specialist_assignment_head()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW.id,NEW.company_id,NEW.project_id,NEW.specialist_binding_id,NEW.requester,NEW.responsible,NEW.origin,NEW.destination,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.project_id,OLD.specialist_binding_id,OLD.requester,OLD.responsible,OLD.origin,OLD.destination,OLD.created_at) THEN
    RAISE EXCEPTION 'Assignment ownership, responsibility, origin and destination are immutable'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_identity_immutable';
  END IF;
  IF NEW.revision<>OLD.revision+1
    OR NEW.input_revision NOT IN (OLD.input_revision,OLD.input_revision+1)
    OR NEW.context_revision NOT IN (OLD.context_revision,OLD.context_revision+1) THEN
    RAISE EXCEPTION 'Assignment changes require the next business revision and coherent input/context heads'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_head_revision';
  END IF;
  IF OLD.status='completed' THEN
    RAISE EXCEPTION 'A completed assignment cannot be changed; submit independent work'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_completed_immutable';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='queued' AND NEW.status IN ('active','waiting_input','failed','cancelled'))
    OR (OLD.status='active' AND NEW.status IN ('waiting_input','waiting_children','waiting_resource','reconciling','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='waiting_input' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_input' AND NEW.status='active' AND NEW.input_revision=OLD.input_revision+1 AND EXISTS(
      SELECT 1 FROM hitl_requests question JOIN runs source ON source.id=question.run_id
      JOIN specialist_input_revisions input ON input.assignment_id=OLD.id AND input.revision=NEW.input_revision
      WHERE question.specialist_assignment_id=OLD.id AND question.specialist_input_revision=OLD.input_revision
        AND question.specialist_answer_input_revision=NEW.input_revision AND question.specialist_answer IS NOT NULL
        AND question.specialist_answer->>'inputSha256'=input.digest
        AND question.specialist_answer->'expectedRevision'=to_jsonb(OLD.revision)
        AND question.activation_state='active' AND question.responded_at IS NOT NULL AND question.response IS NOT NULL
        AND question.superseded_at IS NULL AND source.status='NeedsInputIdle'
    ))
    OR (OLD.status='waiting_children' AND NEW.status IN ('queued','failed','cancelled'))
    OR (OLD.status='waiting_resource' AND NEW.status IN ('queued','reconciling','failed','cancelled'))
    OR (OLD.status='reconciling' AND NEW.status IN ('queued','awaiting_acceptance','failed','cancelled'))
    OR (OLD.status='awaiting_acceptance' AND NEW.status IN ('queued','completed','failed','cancelled'))
    OR (OLD.status IN ('failed','cancelled') AND NEW.status IN ('queued','reconciling'))
  ) THEN
    RAISE EXCEPTION 'The requested assignment state transition is not allowed'
      USING ERRCODE='23514', CONSTRAINT='specialist_assignments_transition';
  END IF;
  IF NEW.status='awaiting_acceptance' AND OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (
    SELECT 1 FROM specialist_delivery_receipts witness
    WHERE witness.assignment_id=NEW.id AND witness.input_revision=NEW.input_revision
      AND specialist_final_result_id(NEW.id,NEW.input_revision,witness.run_id,witness.result_revision) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Awaiting acceptance requires an eligible current root result'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignments_result_ready_required';
  END IF;
  IF NEW.status='completed' AND NOT EXISTS (
    SELECT 1 FROM specialist_acceptances accepted
    WHERE accepted.id=NEW.acceptance_id AND accepted.assignment_id=NEW.id AND accepted.expected_revision=OLD.revision
      AND accepted.input_revision=NEW.input_revision AND accepted.context_revision=NEW.context_revision
  ) THEN
    RAISE EXCEPTION 'Assignment completion requires its exact acceptance receipt'
      USING ERRCODE='23514',CONSTRAINT='specialist_assignments_acceptance_required';
  END IF;
  RETURN NEW;
END;
$function$;
