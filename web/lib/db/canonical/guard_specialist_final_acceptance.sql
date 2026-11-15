CREATE OR REPLACE FUNCTION public.guard_specialist_final_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Final assignment acceptance is immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments subject
    JOIN users author ON author.id=NEW.actor->>'id' AND author.account_status='active'
    JOIN specialist_delivery_receipts witness ON witness.assignment_id=subject.id AND witness.input_revision=NEW.input_revision
      AND witness.run_id=NEW.run_id AND witness.result_revision=NEW.result_revision
    WHERE subject.id=NEW.assignment_id AND subject.status='awaiting_acceptance' AND subject.revision=NEW.expected_revision
      AND subject.input_revision=NEW.input_revision AND subject.context_revision=NEW.context_revision
      AND specialist_final_result_id(subject.id,NEW.input_revision,NEW.run_id,NEW.result_revision)=NEW.result_id
  ) THEN
    RAISE EXCEPTION 'Acceptance requires an exact eligible result and current assignment heads'
      USING ERRCODE='23514',CONSTRAINT='specialist_acceptances_result_required';
  END IF;
  RETURN NEW;
END $function$;
