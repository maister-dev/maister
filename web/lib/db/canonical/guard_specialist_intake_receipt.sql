CREATE OR REPLACE FUNCTION public.guard_specialist_intake_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Specialist intake receipts are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_intake_receipts_immutable';
  END IF;
  IF (NEW.disposition='created' AND NOT EXISTS (
    SELECT 1 FROM specialist_assignments assignment JOIN specialist_input_revisions input
      ON input.assignment_id=assignment.id AND input.revision=NEW.input_revision
    WHERE assignment.id=NEW.assignment_id AND assignment.origin->>'kind'=NEW.source_kind AND input.actor=NEW.actor
  )) OR (NEW.disposition='delegated' AND NOT EXISTS (
    SELECT 1 FROM specialist_work work WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision
      AND work.assignment_id=NEW.assignment_id AND work.input_revision=NEW.input_revision AND work.actor=NEW.actor
      AND work.source_key=NEW.source_key AND work.request_sha256=NEW.request_digest AND NEW.source_kind='delegation'
  )) THEN
    RAISE EXCEPTION 'Specialist intake receipt must identify its exact source and server-attributed input or work'
      USING ERRCODE='23514',CONSTRAINT='specialist_intake_receipts_binding';
  END IF;
  RETURN NEW;
END;
$function$;
